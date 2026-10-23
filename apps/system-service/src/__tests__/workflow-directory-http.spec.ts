import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Body, Controller, HttpException, HttpStatus, Post, ValidationPipe } from '@nestjs/common';
import type { ExceptionFilter, INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_DIRECTORY_LIMITS } from '../constants/workflow-directory.constants';
import {
  WorkflowDirectoryFileQueryDto,
  WorkflowDirectorySaveDto,
} from '../modules/workflow-directory/dto/workflow-directory.dto';
import { WorkflowDirectoryController } from '../modules/workflow-directory/workflow-directory.controller';
import { WorkflowDirectoryHttpService } from '../modules/workflow-directory/workflow-directory-http.service';
import { WorkflowDirectoryService } from '../modules/workflow-directory/workflow-directory.service';

const SECRET = 'SECRET_TOKEN_9f3a7c';
const API = '/api/workflow-directory';
const CASE_BASE = resolve(__dirname, '../../node_modules/.cache/workflow-directory-tests');
const REVISION = 'a'.repeat(64);

const startNode = {
  id: 'start',
  type: 'start',
  version: 1,
  name: '开始',
  position: { x: 0, y: 0 },
  size: { width: 320, height: 520 },
  config: { githubToken: SECRET },
};
const textNode = {
  id: 'text-1',
  type: 'text',
  version: 1,
  name: '文本',
  position: { x: 10, y: 20 },
  size: { width: 320, height: 280 },
  config: { text: 'hello' },
};

function workflow(name = '测试流程'): string {
  return JSON.stringify({
    version: 1,
    id: 'wf-test',
    name,
    nodes: [startNode, textNode],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}

/** 其他路由用于确认目录路径之外的行为不变。 */
@Controller('api/other')
class EchoController {
  @Post('echo')
  echo(@Body() body: Record<string, unknown>) {
    return { received: body };
  }
}

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(level: string, args: unknown[]) {
    this.lines.push(
      `${level} ${args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')}`,
    );
  }
  log(...args: unknown[]) {
    this.push('log', args);
  }
  error(...args: unknown[]) {
    this.push('error', args);
  }
  warn(...args: unknown[]) {
    this.push('warn', args);
  }
  debug(...args: unknown[]) {
    this.push('debug', args);
  }
  verbose(...args: unknown[]) {
    this.push('verbose', args);
  }
}

/** vitest 的转译器不输出 emitDecoratorMetadata；补齐 tsc 构建会产生的 design:* 元数据。 */
function emulateDecoratorMetadata() {
  const define = (types: unknown[], target: object, key?: string) =>
    key === undefined
      ? Reflect.defineMetadata('design:paramtypes', types, target)
      : Reflect.defineMetadata('design:paramtypes', types, target, key);
  define([WorkflowDirectoryService], WorkflowDirectoryController);
  define([], WorkflowDirectoryController.prototype, 'list');
  define([WorkflowDirectoryFileQueryDto], WorkflowDirectoryController.prototype, 'read');
  define([WorkflowDirectorySaveDto], WorkflowDirectoryController.prototype, 'save');
  define([Object], EchoController.prototype, 'echo');
  Reflect.defineMetadata(
    'design:type',
    String,
    WorkflowDirectoryFileQueryDto.prototype,
    'filename',
  );
  for (const field of ['filename', 'text']) {
    Reflect.defineMetadata('design:type', String, WorkflowDirectorySaveDto.prototype, field);
  }
  Reflect.defineMetadata(
    'design:type',
    Object,
    WorkflowDirectorySaveDto.prototype,
    'expectedRevision',
  );
}

let logger: CaptureLogger;
let app: INestApplication;
let root: string;

/** 按 common-service bootstrap 的装配顺序创建应用：专用边界 -> 访问日志 -> 全局 filter/pipe。 */
async function createApp(globalPrefix = '', directory = root): Promise<INestApplication> {
  if (globalPrefix) process.env.GlobalPrefix = globalPrefix;
  else delete process.env.GlobalPrefix;

  emulateDecoratorMetadata();
  const moduleRef = await Test.createTestingModule({
    controllers: [WorkflowDirectoryController, EchoController],
    providers: [WorkflowDirectoryHttpService, WorkflowDirectoryService],
  }).compile();
  Object.defineProperty(moduleRef.get(WorkflowDirectoryService), 'root', { value: directory });
  const nestApp = moduleRef.createNestApplication();
  nestApp.useLogger(logger);
  if (globalPrefix) nestApp.setGlobalPrefix(globalPrefix);

  nestApp.get(WorkflowDirectoryHttpService).mount(nestApp);
  nestApp.use((req: Request, res: Response, next: NextFunction) => {
    // 与生产访问日志相同读取 finish 时的 req.body 与 query
    res.on('finish', () => {
      logger.debug(
        JSON.stringify({
          url: req.originalUrl,
          query: req.query,
          body: req.body || {},
          status: res.statusCode,
        }),
        'HttpAccess',
      );
    });
    next();
  });
  const filterModule = resolve(__dirname, '../../../common-service/src/exception/global.filter.ts');
  const { GlobalExceptionFilter } = (await import(filterModule)) as {
    GlobalExceptionFilter: new () => ExceptionFilter;
  };
  nestApp.useGlobalFilters(new GlobalExceptionFilter());
  nestApp.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      whitelist: true,
      forbidNonWhitelisted: false,
      validationError: { value: true, target: true },
      exceptionFactory: (e) => {
        throw new HttpException(e, HttpStatus.BAD_REQUEST);
      },
    }),
  );
  await nestApp.init();
  return nestApp;
}

const server = () => request(app.getHttpServer());
const flush = () => new Promise((done) => setTimeout(done, 20));
const allLogs = () => logger.lines.join('\n');

function expectNoLeak(response: { text: string }) {
  for (const text of [response.text, allLogs()]) {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(root);
  }
}

beforeEach(async () => {
  mkdirSync(CASE_BASE, { recursive: true });
  root = mkdtempSync(join(CASE_BASE, 'http-'));
  logger = new CaptureLogger();
  app = await createApp();
});

afterEach(async () => {
  await app?.close();
  delete process.env.GlobalPrefix;
  rmSync(root, { recursive: true, force: true });
});

describe('workflow directory HTTP success path', () => {
  it('lists, creates, reads and overwrites through the real service', async () => {
    const empty = await server().get(`${API}/list`);
    expect(empty.status).toBe(200);
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(empty.body).toEqual({
      data: { directory: 'public/workflow', list: [] },
      message: 'ok',
      code: 200,
    });

    const created = await server()
      .post(`${API}/document`)
      .send({ filename: 'a.json', text: workflow(), expectedRevision: null });
    await flush();
    expect(created.status).toBe(200);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body.data).toEqual({
      filename: 'a.json',
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(readFileSync(join(root, 'a.json'), 'utf8')).not.toContain(SECRET);
    // 访问日志在 finish 时 body 已被清空，不含工作流原文
    expect(allLogs()).toContain('"body":{}');
    expect(allLogs()).not.toContain(SECRET);

    const read = await server().get(`${API}/document`).query({ filename: 'a.json' });
    expect(read.status).toBe(200);
    expect(read.body.data.revision).toBe(created.body.data.revision);
    expect(JSON.parse(read.body.data.text).nodes[0].config.githubToken).toBe('');

    const overwritten = await server()
      .post(`${API}/document`)
      .send({
        filename: 'a.json',
        text: workflow('第二版'),
        expectedRevision: created.body.data.revision,
      });
    expect(overwritten.status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, 'a.json'), 'utf8')).name).toBe('第二版');
    expect(readdirSync(root)).toEqual(['a.json']);
    expectNoLeak(read);
  });

  it('mounts the boundary under the global prefix and ends the unprefixed path', async () => {
    await app.close();
    app = await createApp('nest');

    expect((await server().get(`/nest${API}/list`)).status).toBe(200);
    const unprefixed = await server()
      .post(`${API}/document`)
      .send({ filename: 'a.json', text: workflow(), expectedRevision: null });
    await flush();
    expect(unprefixed.status).toBe(404);
    expect(readdirSync(root)).toEqual([]);
    expectNoLeak(unprefixed);
  });

  it('keeps request bodies of other routes', async () => {
    const response = await server().post('/api/other/echo').send({ hello: 'world' });
    await flush();
    expect(response.body).toEqual({ received: { hello: 'world' } });
    expect(allLogs()).toContain('"body":{"hello":"world"}');
  });
});

describe('workflow directory HTTP errors', () => {
  it('returns 404 for a missing file', async () => {
    const response = await server().get(`${API}/document`).query({ filename: 'none.json' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ data: null, message: '工作流文件不存在', code: 404 });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns 409 with a top-level revision for version conflicts', async () => {
    writeFileSync(join(root, 'a.json'), workflow());

    const existing = await server()
      .post(`${API}/document`)
      .send({ filename: 'a.json', text: workflow('覆盖'), expectedRevision: null });
    expect(existing.status).toBe(409);
    expect(existing.body).toEqual({
      data: null,
      message: '文件版本已变化，请重新读取后确认',
      code: 409,
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const removed = await server()
      .post(`${API}/document`)
      .send({ filename: 'none.json', text: workflow(), expectedRevision: REVISION });
    expect(removed.status).toBe(409);
    expect(removed.body.revision).toBeNull();
    expect(JSON.parse(readFileSync(join(root, 'a.json'), 'utf8')).name).toBe('测试流程');
  });

  it('treats a missing directory as an empty list and a 404 read without creating it', async () => {
    const absent = join(root, 'absent');
    await app.close();
    app = await createApp('', absent);

    const list = await server().get(`${API}/list`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual({ directory: 'public/workflow', list: [] });
    const read = await server().get(`${API}/document`).query({ filename: 'a.json' });
    expect(read.status).toBe(404);
    expect(existsSync(absent)).toBe(false);
  });

  it('returns a safe 500 without paths when the directory is unavailable', async () => {
    writeFileSync(join(root, 'not-a-directory'), '');
    await app.close();
    app = await createApp('', join(root, 'not-a-directory'));

    const response = await server().get(`${API}/list`);
    await flush();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ data: null, message: '工作流目录不可用', code: 500 });
    expectNoLeak(response);
  });

  it('rejects invalid document content without leaking it', async () => {
    const response = await server()
      .post(`${API}/document`)
      .send({ filename: 'a.json', text: `{"leak":"${SECRET}"`, expectedRevision: null });
    await flush();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ data: null, message: '工作流文件内容无效', code: 400 });
    expectNoLeak(response);
  });

  it.each([
    ['missing filename', {}],
    ['unknown parameter', { filename: 'a.json', extra: '1' }],
    ['repeated filename', 'filename=a.json&filename=b.json'],
    ['object filename', 'filename[x]=1'],
    ['too long', { filename: 'x'.repeat(121) }],
  ])('rejects document query with %s', async (_name, query) => {
    const response = await server().get(`${API}/document`).query(query);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ data: null, message: '请求参数不合法', code: 400 });
  });

  it('rejects unknown list parameters and invalid filenames', async () => {
    expect((await server().get(`${API}/list`).query({ path: '..' })).status).toBe(400);
    for (const filename of ['../a.json', 'a/b.json', 'CON.json', 'a.txt']) {
      const response = await server().get(`${API}/document`).query({ filename });
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('文件名不合法');
    }
  });

  it.each([
    ['missing expectedRevision', { filename: 'a.json', text: SECRET }],
    ['missing text', { filename: 'a.json', expectedRevision: null }],
    ['unknown field', { filename: 'a.json', text: SECRET, expectedRevision: null, extra: 1 }],
    ['numeric text', { filename: 'a.json', text: 12345, expectedRevision: null }],
    ['array filename', { filename: ['a.json'], text: SECRET, expectedRevision: null }],
    ['uppercase revision', { filename: 'a.json', text: SECRET, expectedRevision: 'A'.repeat(64) }],
    ['short revision', { filename: 'a.json', text: SECRET, expectedRevision: 'abc' }],
    ['numeric revision', { filename: 'a.json', text: SECRET, expectedRevision: 1 }],
    ['empty revision', { filename: 'a.json', text: SECRET, expectedRevision: '' }],
    ['object text', { filename: 'a.json', text: { v: SECRET }, expectedRevision: null }],
  ])('rejects save body with %s without leaking values', async (_name, body) => {
    const response = await server().post(`${API}/document`).send(body);
    await flush();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ data: null, message: '请求参数不合法', code: 400 });
    expect(readdirSync(root)).toEqual([]);
    expectNoLeak(response);
  });

  it('returns 400 for malformed JSON and non-object bodies without echoing them', async () => {
    for (const payload of [`{"text":"${SECRET}`, `[${JSON.stringify(SECRET)}]`, 'null', '']) {
      const response = await server()
        .post(`${API}/document`)
        .set('Content-Type', 'application/json')
        .send(payload);
      await flush();
      expect(response.status).toBe(400);
      expect(response.body.data).toBeNull();
      expectNoLeak(response);
    }
  });

  it('allows the JSON-escape overhead of a maximal document but rejects larger bodies', async () => {
    // 4 MiB 控制字符经 JSON 转义约 24 MiB：进入文档校验（400），而不是被 parser 拒绝（413）
    const escaped = await server()
      .post(`${API}/document`)
      .send({
        filename: 'a.json',
        text: '\u0001'.repeat(WORKFLOW_DIRECTORY_LIMITS.maxDocumentBytes),
        expectedRevision: null,
      });
    expect(escaped.status).toBe(400);
    expect(escaped.body.message).toBe('工作流文件内容无效');

    const padding = 'a'.repeat(WORKFLOW_DIRECTORY_LIMITS.maxBodyBytes);
    const oversized = await server()
      .post(`${API}/document`)
      .set('Content-Type', 'application/json')
      .send(`{"filename":"a.json","text":"${SECRET}${padding}","expectedRevision":null}`);
    await flush();
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ data: null, message: '工作流文件超过 4 MiB 限制', code: 413 });
    expectNoLeak(oversized);
  }, 60_000);

  it.each([
    ['post', 'list', 'GET'],
    ['put', 'document', 'GET, POST'],
    ['delete', 'document', 'GET, POST'],
    ['patch', 'document', 'GET, POST'],
  ] as const)('returns 405 for %s %s', async (method, route, allow) => {
    const response = await server()[method](`${API}/${route}`);
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe(allow);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['text/plain', `text=${SECRET}`],
    ['application/x-www-form-urlencoded', `filename=a.json&text=${SECRET}`],
  ])('returns 415 for %s', async (contentType, payload) => {
    const response = await server()
      .post(`${API}/document`)
      .set('Content-Type', contentType)
      .send(payload);
    await flush();
    expect(response.status).toBe(415);
    expectNoLeak(response);
  });

  it.each(['/other', '/list/extra', '/', '//list'])(
    'returns 404 for unknown subpath %s',
    async (sub) => {
      const response = await server().get(`${API}${sub}`);
      expect(response.status).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('rejects GET requests that carry a body', async () => {
    const response = await server()
      .get(`${API}/list`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: SECRET }));
    await flush();
    expect(response.status).toBe(400);
    expectNoLeak(response);
  });
});

describe('workflow directory cross-origin protection', () => {
  const body = () => ({ filename: 'a.json', text: workflow(), expectedRevision: null });

  it('accepts same-origin and non-browser requests', async () => {
    const sameOrigin = await server()
      .post(`${API}/document`)
      .set('Host', 'workflow.local')
      .set('Origin', 'http://workflow.local')
      .set('Sec-Fetch-Site', 'same-origin')
      .send(body());
    expect(sameOrigin.status).toBe(200);
    expect((await server().get(`${API}/list`).set('Sec-Fetch-Site', 'none')).status).toBe(200);
  });

  it.each([
    ['foreign origin', { Origin: 'https://evil.example' }],
    ['origin with another port', { Origin: 'http://workflow.local:81' }],
    ['opaque origin', { Origin: 'null' }],
    ['cross-site fetch', { 'Sec-Fetch-Site': 'cross-site' }],
    ['same-site fetch', { 'Sec-Fetch-Site': 'same-site' }],
  ])('rejects writes and reads from %s', async (_name, headers) => {
    const write = await server()
      .post(`${API}/document`)
      .set('Host', 'workflow.local')
      .set(headers)
      .send(body());
    await flush();
    expect(write.status).toBe(403);
    expect(write.body).toEqual({ data: null, message: '请求来源不受信任', code: 403 });
    expect(readdirSync(root)).toEqual([]);

    const read = await server().get(`${API}/list`).set('Host', 'workflow.local').set(headers);
    expect(read.status).toBe(403);
  });
});
