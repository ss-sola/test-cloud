import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { HttpException, HttpStatus, ValidationPipe } from '@nestjs/common';
import type { ExceptionFilter, INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_CAPABILITY_LIMITS } from '../constants/workflow-capability.constants';
import { AiTextCapabilityService } from '../modules/workflow-capabilities/ai-text-capability.service';
import { AiConfigDto, AiTextDto } from '../modules/workflow-capabilities/dto/ai-text.dto';
import {
  FeishuFindRowDto,
  FeishuWriteCellsDto,
} from '../modules/workflow-capabilities/dto/feishu-sheet.dto';
import { GithubCommitsDto } from '../modules/workflow-capabilities/dto/github-commits.dto';
import { FeishuSheetCapabilityService } from '../modules/workflow-capabilities/feishu-sheet-capability.service';
import { GithubCommitsCapabilityService } from '../modules/workflow-capabilities/github-commits-capability.service';
import { WorkflowCapabilityController } from '../modules/workflow-capabilities/workflow-capability.controller';
import { WorkflowCapabilityException } from '../modules/workflow-capabilities/workflow-capability.exception';
import { WorkflowCapabilityHttpService } from '../modules/workflow-capabilities/workflow-capability-http.service';

const SECRET = 'SECRET_TOKEN_9f3a7c';
const CONTENT = 'CONTENT_SECRET_41d2';
const BASE = '/api/workflow-capabilities';

const GITHUB_BODY = {
  repository: 'octo/repo',
  branch: 'main',
  author: 'alice',
  since: '2026-10-12T00:00:00+08:00',
  until: '2026-10-19T00:00:00+08:00',
  maxCommits: 100,
  runtime: { githubToken: SECRET },
};
const AI_BODY = {
  prompt: `总结 ${CONTENT}`,
  systemPrompt: 'sys',
  runtime: { ai: { baseUrl: 'https://api.example.com/v1', apiKey: SECRET, model: 'm' } },
};
const FIND_BODY = {
  wikiUrl: 'https://example.feishu.cn/wiki/test-node?sheet=sheet1',
  range: 'A1:B20',
  matches: [{ column: 'B', value: CONTENT, mode: 'equals' }],
  runtime: { appId: 'cli_app', appSecret: SECRET },
};
const WRITE_BODY = {
  wikiUrl: 'https://example.feishu.cn/wiki/test-node?sheet=sheet1',
  range: 'C12:D12',
  values: [[CONTENT, '二']],
  confirmed: true,
  runtime: { appId: 'cli_app', appSecret: SECRET },
};

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

/** vitest 转译器不输出 emitDecoratorMetadata，这里补齐 tsc 构建会产生的 design:* 元数据。 */
function emulateDecoratorMetadata() {
  Reflect.defineMetadata('design:type', Boolean, AiConfigDto.prototype, 'enableThinking');
  Reflect.defineMetadata(
    'design:paramtypes',
    [
      GithubCommitsCapabilityService,
      AiTextCapabilityService,
      FeishuSheetCapabilityService,
      WorkflowCapabilityHttpService,
    ],
    WorkflowCapabilityController,
  );
  const methods: Array<[string, unknown]> = [
    ['githubCommits', GithubCommitsDto],
    ['aiText', AiTextDto],
    ['feishuFindRow', FeishuFindRowDto],
    ['feishuWriteCells', FeishuWriteCellsDto],
  ];
  for (const [method, dto] of methods) {
    Reflect.defineMetadata(
      'design:paramtypes',
      [dto, Object, Object],
      WorkflowCapabilityController.prototype,
      method,
    );
  }
}

const github = { query: vi.fn() };
const ai = { generate: vi.fn() };
const feishu = { findRow: vi.fn(), writeCells: vi.fn() };
let logger: CaptureLogger;
let app: INestApplication;

/** 按 common-service bootstrap 的顺序装配：专用边界 -> 访问日志 -> 全局 filter/pipe。 */
async function createApp(globalPrefix = ''): Promise<INestApplication> {
  if (globalPrefix) process.env.GlobalPrefix = globalPrefix;
  else delete process.env.GlobalPrefix;

  emulateDecoratorMetadata();
  const moduleRef = await Test.createTestingModule({
    controllers: [WorkflowCapabilityController],
    providers: [
      WorkflowCapabilityHttpService,
      { provide: GithubCommitsCapabilityService, useValue: github },
      { provide: AiTextCapabilityService, useValue: ai },
      { provide: FeishuSheetCapabilityService, useValue: feishu },
    ],
  }).compile();
  const nestApp = moduleRef.createNestApplication();
  nestApp.useLogger(logger);
  if (globalPrefix) nestApp.setGlobalPrefix(globalPrefix);

  nestApp.get(WorkflowCapabilityHttpService).mount(nestApp);
  nestApp.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      logger.debug(
        JSON.stringify({ url: req.originalUrl, body: req.body || {}, status: res.statusCode }),
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

function mutate(base: any, change: (copy: any) => void) {
  const copy = JSON.parse(JSON.stringify(base));
  change(copy);
  return copy;
}

const server = () => request(app.getHttpServer());
const flush = () => new Promise((done) => setTimeout(done, 20));
const allLogs = () => logger.lines.join('\n');

function expectNoLeak(response: { text: string }) {
  for (const secret of [SECRET, CONTENT]) {
    expect(response.text).not.toContain(secret);
    expect(allLogs()).not.toContain(secret);
  }
}

beforeEach(async () => {
  for (const mock of [github.query, ai.generate, feishu.findRow, feishu.writeCells])
    mock.mockReset();
  github.query.mockResolvedValue([{ hash: 'a', isMerge: false }]);
  ai.generate.mockResolvedValue({ text: '结果' });
  feishu.findRow.mockResolvedValue({ wikiUrl: FIND_BODY.wikiUrl, row: 3, sheetId: 'sheet1' });
  feishu.writeCells.mockResolvedValue({ range: 'C12:D12', updatedCells: 2, status: 'written' });
  logger = new CaptureLogger();
  app = await createApp();
});

afterEach(async () => {
  await app?.close();
  delete process.env.GlobalPrefix;
});

describe('workflow capability HTTP success path', () => {
  it.each([
    ['github-commits', GITHUB_BODY, github.query, [{ hash: 'a', isMerge: false }]],
    ['ai-text', AI_BODY, ai.generate, { text: '结果' }],
    [
      'feishu-find-row',
      FIND_BODY,
      feishu.findRow,
      { wikiUrl: FIND_BODY.wikiUrl, row: 3, sheetId: 'sheet1' },
    ],
    [
      'feishu-write-cells',
      WRITE_BODY,
      feishu.writeCells,
      { range: 'C12:D12', updatedCells: 2, status: 'written' },
    ],
  ])(
    'serves %s with no-store, a bare data payload and an empty logged body',
    async (path, body, mock, data) => {
      const response = await server().post(`${BASE}/${path}`).send(body);
      await flush();

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ data, message: 'ok', code: 200 });
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0][0]).toMatchObject(JSON.parse(JSON.stringify(body)));
      expect(mock.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
      expect(allLogs()).toContain('"body":{}');
      expect(allLogs()).not.toContain(SECRET);
      expect(allLogs()).not.toContain(CONTENT);
    },
  );

  it.each([false, true])(
    'preserves runtime.ai.enableThinking=%s through strict and global validation',
    async (enableThinking) => {
      const body = mutate(AI_BODY, (b) => (b.runtime.ai.enableThinking = enableThinking));
      const response = await server().post(`${BASE}/ai-text`).send(body);
      expect(response.status).toBe(200);
      expect(ai.generate).toHaveBeenCalledOnce();
      expect(ai.generate.mock.calls[0][0].runtime.ai.enableThinking).toBe(enableThinking);
    },
  );

  it('accepts optional fields as omitted', async () => {
    const minimal = mutate(GITHUB_BODY, (b) => {
      delete b.branch;
      delete b.author;
    });
    const response = await server().post(`${BASE}/github-commits`).send(minimal);
    expect(response.status).toBe(200);
  });

  it('mounts under the global prefix and ends unprefixed paths without reading the body', async () => {
    await app.close();
    app = await createApp('nest');

    const prefixed = await server().post(`/nest${BASE}/ai-text`).send(AI_BODY);
    expect(prefixed.status).toBe(200);
    expect(prefixed.headers['cache-control']).toBe('no-store');

    const unprefixed = await server().post(`${BASE}/ai-text`).send(AI_BODY);
    await flush();
    expect(unprefixed.status).toBe(404);
    expect(ai.generate).toHaveBeenCalledTimes(1);
    expectNoLeak(unprefixed);
  });
});

describe('workflow capability error boundary', () => {
  it('returns controlled exception messages and hides everything else', async () => {
    feishu.findRow.mockRejectedValue(
      new WorkflowCapabilityException('指定范围内没有匹配的行。', 404),
    );
    const controlled = await server().post(`${BASE}/feishu-find-row`).send(FIND_BODY);
    await flush();
    expect(controlled.status).toBe(404);
    expect(controlled.body).toEqual({ data: null, message: '指定范围内没有匹配的行。', code: 404 });
    expect(controlled.headers['cache-control']).toBe('no-store');
    expectNoLeak(controlled);

    ai.generate.mockRejectedValue(new Error(`upstream said ${SECRET} ${CONTENT}`));
    const unexpected = await server().post(`${BASE}/ai-text`).send(AI_BODY);
    await flush();
    expect(unexpected.status).toBe(500);
    expect(unexpected.body).toEqual({ data: null, message: '服务器内部错误', code: 500 });
    expectNoLeak(unexpected);
    expect(allLogs()).not.toContain('upstream said');

    github.query.mockRejectedValue(new HttpException(`plain ${SECRET}`, 502));
    const plain = await server().post(`${BASE}/github-commits`).send(GITHUB_BODY);
    await flush();
    expect(plain.status).toBe(502);
    expect(plain.body.message).not.toContain(SECRET);
    expectNoLeak(plain);
  });

  it.each([
    [
      'github unknown top-level field',
      'github-commits',
      mutate(GITHUB_BODY, (b) => (b.extra = SECRET)),
    ],
    [
      'github unknown nested field',
      'github-commits',
      mutate(GITHUB_BODY, (b) => (b.runtime.extra = SECRET)),
    ],
    [
      'github numeric string maxCommits',
      'github-commits',
      mutate(GITHUB_BODY, (b) => (b.maxCommits = '100')),
    ],
    [
      'github maxCommits above budget',
      'github-commits',
      mutate(GITHUB_BODY, (b) => (b.maxCommits = 501)),
    ],
    ['github non-ISO date', 'github-commits', mutate(GITHUB_BODY, (b) => (b.since = '2026-10-12'))],
    [
      'github token with newline',
      'github-commits',
      mutate(GITHUB_BODY, (b) => (b.runtime.githubToken = `${SECRET}\nX: y`)),
    ],
    [
      'github non-string repository',
      'github-commits',
      mutate(GITHUB_BODY, (b) => (b.repository = [SECRET])),
    ],
    ['github missing runtime', 'github-commits', mutate(GITHUB_BODY, (b) => delete b.runtime)],
    ['ai non-string prompt', 'ai-text', mutate(AI_BODY, (b) => (b.prompt = 12345))],
    [
      'ai prompt above budget',
      'ai-text',
      mutate(
        AI_BODY,
        (b) => (b.prompt = 'a'.repeat(WORKFLOW_CAPABILITY_LIMITS.aiMaxPromptChars + 1)),
      ),
    ],
    ['ai legacy maxTokens non-integer', 'ai-text', mutate(AI_BODY, (b) => (b.maxTokens = '8193'))],
    ['ai unknown nested field', 'ai-text', mutate(AI_BODY, (b) => (b.runtime.ai.temperature = 1))],
    ['ai runtime as array', 'ai-text', mutate(AI_BODY, (b) => (b.runtime = [SECRET]))],
    ['find match mode', 'feishu-find-row', mutate(FIND_BODY, (b) => (b.matches[0].mode = 'regex'))],
    ['find match column', 'feishu-find-row', mutate(FIND_BODY, (b) => (b.matches[0].column = 'b'))],
    [
      'find unknown match field',
      'feishu-find-row',
      mutate(FIND_BODY, (b) => (b.matches[0].extra = 1)),
    ],
    [
      'find too many matches',
      'feishu-find-row',
      mutate(FIND_BODY, (b) => (b.matches = Array(6).fill(b.matches[0]))),
    ],
    [
      'find sheet-qualified range',
      'feishu-find-row',
      mutate(FIND_BODY, (b) => (b.range = 'sheet1!A1:B2')),
    ],
    ['find empty matches', 'feishu-find-row', mutate(FIND_BODY, (b) => (b.matches = []))],
    [
      'write confirmed missing',
      'feishu-write-cells',
      mutate(WRITE_BODY, (b) => delete b.confirmed),
    ],
    [
      'write confirmed false',
      'feishu-write-cells',
      mutate(WRITE_BODY, (b) => (b.confirmed = false)),
    ],
    [
      'write confirmed string',
      'feishu-write-cells',
      mutate(WRITE_BODY, (b) => (b.confirmed = 'true')),
    ],
    ['write confirmed number', 'feishu-write-cells', mutate(WRITE_BODY, (b) => (b.confirmed = 1))],
    [
      'write ragged matrix',
      'feishu-write-cells',
      mutate(WRITE_BODY, (b) => (b.values = [['a', 'b'], ['c']])),
    ],
    [
      'write object cell',
      'feishu-write-cells',
      mutate(WRITE_BODY, (b) => (b.values = [[{ formula: CONTENT }, 'b']])),
    ],
    ['write empty matrix', 'feishu-write-cells', mutate(WRITE_BODY, (b) => (b.values = []))],
    [
      'write non-array matrix',
      'feishu-write-cells',
      mutate(WRITE_BODY, (b) => (b.values = CONTENT)),
    ],
    [
      'write oversized cell',
      'feishu-write-cells',
      mutate(WRITE_BODY, (b) => (b.values = [['x'.repeat(8001), 'b']])),
    ],
    [
      'write too many cells',
      'feishu-write-cells',
      mutate(WRITE_BODY, (b) => (b.values = Array.from({ length: 41 }, () => Array(50).fill('a')))),
    ],
    ['write unknown field', 'feishu-write-cells', mutate(WRITE_BODY, (b) => (b.dryRun = true))],
    [
      'write app secret with space',
      'feishu-write-cells',
      mutate(WRITE_BODY, (b) => (b.runtime.appSecret = `${SECRET} x`)),
    ],
  ])('rejects %s with a fixed 400 and no leak', async (_name, path, body) => {
    const response = await server().post(`${BASE}/${path}`).send(body);
    await flush();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ data: null, message: '请求参数不合法', code: 400 });
    expect(response.headers['cache-control']).toBe('no-store');
    for (const mock of [github.query, ai.generate, feishu.findRow, feishu.writeCells]) {
      expect(mock).not.toHaveBeenCalled();
    }
    expectNoLeak(response);
  });

  it.each([null, 'false', 'true', 0, 1, [], {}])(
    'rejects non-boolean runtime.ai.enableThinking=%j without calling AI',
    async (enableThinking) => {
      const body = mutate(AI_BODY, (b) => (b.runtime.ai.enableThinking = enableThinking));
      const response = await server().post(`${BASE}/ai-text`).send(body);
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('请求参数不合法');
      expect(ai.generate).not.toHaveBeenCalled();
      expectNoLeak(response);
    },
  );

  it.each([0, -1, 4096, 8193, 1_000_000])(
    'accepts the ignored optional legacy maxTokens=%i without a token bound',
    async (maxTokens) => {
      const response = await server()
        .post(`${BASE}/ai-text`)
        .send({ ...AI_BODY, maxTokens });
      expect(response.status).toBe(200);
      expect(ai.generate).toHaveBeenCalledOnce();
      expect(ai.generate.mock.calls[0][0]).toMatchObject({
        prompt: AI_BODY.prompt,
        runtime: AI_BODY.runtime,
      });
    },
  );

  it.each([4096, 100_000, 1_000_000])(
    'passes contextWindowTokens=%i unchanged and keeps it independent of the legacy maxTokens',
    async (contextWindowTokens) => {
      const response = await server()
        .post(`${BASE}/ai-text`)
        .send({ ...AI_BODY, contextWindowTokens, maxTokens: 64 });
      expect(response.status).toBe(200);
      expect(ai.generate).toHaveBeenCalledOnce();
      expect(ai.generate.mock.calls[0][0].contextWindowTokens).toBe(contextWindowTokens);
    },
  );

  it('leaves an omitted contextWindowTokens undefined at the DTO boundary instead of coercing a value', async () => {
    const response = await server().post(`${BASE}/ai-text`).send(AI_BODY);
    expect(response.status).toBe(200);
    expect(ai.generate.mock.calls[0][0].contextWindowTokens).toBeUndefined();
  });

  it.each([
    [4095],
    [1_000_001],
    [0],
    [-1],
    [4096.5],
    ['8192'],
    [''],
    [null],
    [true],
    [false],
    [[8192]],
    [{ value: 8192 }],
  ])('rejects contextWindowTokens %j without implicit conversion', async (contextWindowTokens) => {
    const response = await server()
      .post(`${BASE}/ai-text`)
      .send({ ...AI_BODY, contextWindowTokens });
    await flush();
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ data: null, message: '请求参数不合法', code: 400 });
    expect(ai.generate).not.toHaveBeenCalled();
    expectNoLeak(response);
  });

  it('accepts null, boolean and numeric cells in the write matrix', async () => {
    const response = await server()
      .post(`${BASE}/feishu-write-cells`)
      .send(
        mutate(
          WRITE_BODY,
          (b) =>
            (b.values = [
              [null, 1.5],
              [true, '=x'],
            ]),
        ),
      );
    expect(response.status).toBe(200);
    expect(feishu.writeCells.mock.calls[0][0].values).toEqual([
      [null, 1.5],
      [true, '=x'],
    ]);
  });

  it('returns 400 for malformed JSON without echoing the snippet', async () => {
    const response = await server()
      .post(`${BASE}/ai-text`)
      .set('Content-Type', 'application/json')
      .send(`{"prompt":"${SECRET}`);
    await flush();
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ data: null, message: '请求体不是有效的 JSON 对象', code: 400 });
    expectNoLeak(response);
  });

  it.each([`[${JSON.stringify(SECRET)}]`, 'null', '', `"${SECRET}"`])(
    'rejects non-object body %j',
    async (payload) => {
      const response = await server()
        .post(`${BASE}/ai-text`)
        .set('Content-Type', 'application/json')
        .send(payload);
      await flush();
      expect(response.status).toBe(400);
      expect(ai.generate).not.toHaveBeenCalled();
      expectNoLeak(response);
    },
  );

  it('returns 413 beyond the dedicated body limit', async () => {
    const padding = 'a'.repeat(WORKFLOW_CAPABILITY_LIMITS.maxBodyBytes);
    const response = await server()
      .post(`${BASE}/ai-text`)
      .set('Content-Type', 'application/json')
      .send(`{"prompt":"${SECRET}${padding}"}`);
    await flush();
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ data: null, message: '请求体超过大小限制', code: 413 });
    expectNoLeak(response);
  });

  it.each(['get', 'put', 'delete', 'patch'] as const)('returns 405 for %s', async (method) => {
    const response = await server()
      [method](`${BASE}/ai-text`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(AI_BODY));
    await flush();
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
    expect(response.headers['cache-control']).toBe('no-store');
    expectNoLeak(response);
  });

  it.each([
    ['text/plain', `prompt=${SECRET}`],
    ['application/x-www-form-urlencoded', `prompt=${SECRET}`],
  ])('returns 415 for %s', async (contentType, payload) => {
    const response = await server()
      .post(`${BASE}/ai-text`)
      .set('Content-Type', contentType)
      .send(payload);
    await flush();
    expect(response.status).toBe(415);
    expect(ai.generate).not.toHaveBeenCalled();
    expectNoLeak(response);
  });

  it.each(['/unknown', '/ai-text/extra', '/', '//ai-text', '/jobs'])(
    'returns 404 for unknown subpath %s',
    async (sub) => {
      const response = await server()
        .post(`${BASE}${sub}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(AI_BODY));
      await flush();
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ data: null, message: '接口未找到', code: 404 });
      expect(response.headers['cache-control']).toBe('no-store');
      expectNoLeak(response);
    },
  );
});

describe('workflow capability cancellation', () => {
  /** 打开真实连接发送请求，等待服务端开始处理后返回客户端请求对象。 */
  async function startRequest(path: string, body: unknown) {
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    const payload = JSON.stringify(body);
    const clientRequest = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    clientRequest.on('error', () => undefined);
    clientRequest.end(payload);
    return clientRequest;
  }

  async function waitFor(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i += 1)
      await new Promise((done) => setTimeout(done, 10));
    expect(predicate()).toBe(true);
  }

  it('aborts the capability signal when the client disconnects before the response', async () => {
    let captured: AbortSignal | undefined;
    ai.generate.mockImplementation(
      (_body: unknown, signal: AbortSignal) =>
        new Promise((done) => {
          captured = signal;
          signal.addEventListener('abort', () => done({ text: 'late' }));
        }),
    );

    const clientRequest = await startRequest(`${BASE}/ai-text`, AI_BODY);
    await waitFor(() => captured !== undefined);
    expect(captured?.aborted).toBe(false);
    clientRequest.destroy();
    await waitFor(() => captured?.aborted === true);
  });

  it('does not abort on the normal request close of a completed POST', async () => {
    let captured: AbortSignal | undefined;
    ai.generate.mockImplementation(async (_body: unknown, signal: AbortSignal) => {
      captured = signal;
      await new Promise((done) => setTimeout(done, 40));
      return { text: 'ok' };
    });

    const response = await server().post(`${BASE}/ai-text`).send(AI_BODY);
    await flush();
    expect(response.status).toBe(200);
    expect(captured?.aborted).toBe(false);
  });
});
