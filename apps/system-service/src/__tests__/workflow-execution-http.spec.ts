import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Body, Controller, HttpException, HttpStatus, Post, ValidationPipe } from '@nestjs/common';
import type { ExceptionFilter, INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKFLOW_EXECUTION_ERRORS,
  WORKFLOW_EXECUTION_LIMITS,
} from '../constants/workflow-execution.constants';
import {
  WorkflowConfirmDto,
  WorkflowEventsQueryDto,
  WorkflowRunDto,
  WorkflowStatusQueryDto,
  WorkflowStopDto,
} from '../modules/workflow-execution/dto/workflow-execution.dto';
import { WorkflowExecutionController } from '../modules/workflow-execution/workflow-execution.controller';
import { WorkflowExecutionHttpService } from '../modules/workflow-execution/workflow-execution-http.service';
import { WorkflowExecutionException } from '../modules/workflow-execution/workflow-execution.exception';
import { WorkflowExecutionService } from '../modules/workflow-execution/workflow-execution.service';
import type { ExecutionEvent } from '../modules/workflow-execution/workflow-execution.types';

// 控制器只依赖服务的公开方法；这里用可控替身，避免加载执行引擎与外部能力
vi.mock('../modules/workflow-execution/workflow-execution.service', () => ({
  WorkflowExecutionService: class WorkflowExecutionService {},
}));

const SECRET = 'SECRET_TOKEN_9f3a7c';
const API = '/api/workflow';
const RUN_ID = '3f1c9a52-8d4e-4b7a-9c61-0e5d2b7a1f34';
const CONFIRMATION_ID = 'a1b2c3d4-e5f6-4a8b-8c9d-0123456789ab';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEFGH'.slice(0, 43);
const MIB = 1024 * 1024;

const snapshot = (revision: number, running = true) => ({
  runId: RUN_ID,
  revision,
  running,
  status: running ? 'running' : 'succeeded',
  startedAt: 1,
  finishedAt: running ? null : 2,
  expiresAt: 3,
  states: [{ nodeId: 'text-1', status: running ? 'running' : 'succeeded', message: '' }],
});
const event = (type: ExecutionEvent['type'], revision: number, running = true) =>
  ({ type, data: snapshot(revision, running) }) as ExecutionEvent;

type Listener = (event: ExecutionEvent) => void;

/** 服务替身：令牌不匹配时与真实服务一样抛出固定 404。 */
function createFakeService() {
  const guard = (token: string) => {
    if (token !== TOKEN) throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.notFound);
  };
  return {
    start: vi.fn((_input: unknown) => ({ runId: RUN_ID, accessToken: TOKEN, expiresAt: 3 })),
    status: vi.fn((_query: unknown, token: string) => {
      guard(token);
      return snapshot(1);
    }),
    stop: vi.fn((_runId: string, token: string) => {
      guard(token);
      return snapshot(2, false);
    }),
    confirm: vi.fn((_input: unknown, token: string) => {
      guard(token);
      return snapshot(3);
    }),
    subscribe: vi.fn((_runId: string, token: string, listener: Listener): (() => void) => {
      guard(token);
      listener(event('snapshot', 1));
      return () => undefined;
    }),
  };
}

@Controller('api/workflow-directory')
class DirectoryProbeController {
  @Post('document')
  probe(@Body() body: Record<string, unknown>) {
    return { received: body };
  }
}

@Controller('api/workflow-capabilities')
class CapabilityProbeController {
  @Post('ai-text')
  probe(@Body() body: Record<string, unknown>) {
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
  const proto = WorkflowExecutionController.prototype;
  define([WorkflowExecutionService, WorkflowExecutionHttpService], WorkflowExecutionController);
  define([WorkflowRunDto], proto, 'run');
  define([WorkflowStatusQueryDto, Object], proto, 'status');
  define([WorkflowEventsQueryDto, Object, Object], proto, 'events');
  define([WorkflowStopDto, Object], proto, 'stop');
  define([WorkflowConfirmDto, Object], proto, 'confirm');
  define([Object], DirectoryProbeController.prototype, 'probe');
  define([Object], CapabilityProbeController.prototype, 'probe');
}

let logger: CaptureLogger;
let service: ReturnType<typeof createFakeService>;
let app: INestApplication;
const openStreams: IncomingMessage[] = [];

/** 按 common-service bootstrap 的装配顺序创建应用：任意 Origin CORS -> 专用边界 -> 访问日志 -> 全局 filter/pipe。 */
async function createApp(globalPrefix = ''): Promise<INestApplication> {
  if (globalPrefix) process.env.GlobalPrefix = globalPrefix;
  else delete process.env.GlobalPrefix;

  emulateDecoratorMetadata();
  const moduleRef = await Test.createTestingModule({
    controllers: [WorkflowExecutionController, DirectoryProbeController, CapabilityProbeController],
    providers: [
      WorkflowExecutionHttpService,
      { provide: WorkflowExecutionService, useValue: service },
    ],
  }).compile();
  const nestApp = moduleRef.createNestApplication();
  nestApp.useLogger(logger);
  if (globalPrefix) nestApp.setGlobalPrefix(globalPrefix);
  nestApp.enableCors({ origin: true, credentials: true });

  nestApp.get(WorkflowExecutionHttpService).mount(nestApp);
  nestApp.use((req: Request, res: Response, next: NextFunction) => {
    // 与生产访问日志相同在 finish 时读取 url、query、body，并额外检查请求头
    res.on('finish', () => {
      logger.debug(
        JSON.stringify({
          url: req.originalUrl,
          query: req.query,
          body: req.body || {},
          headers: req.headers,
          rawHeaders: req.rawHeaders,
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

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** 通过真实 HTTP 连接读取 SSE，返回累计文本与关闭状态。 */
async function openStream(path: string, headers: Record<string, string> = {}) {
  const port = ((app.getHttpServer().address() as AddressInfo) ?? { port: 0 }).port;
  const state = { text: '', ended: false, res: undefined as IncomingMessage | undefined };
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      state.res = res;
      openStreams.push(res);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        state.text += chunk;
      });
      res.on('close', () => {
        state.ended = true;
      });
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
  return state;
}

beforeEach(async () => {
  logger = new CaptureLogger();
  service = createFakeService();
  app = await createApp();
  await app.listen(0);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const res of openStreams.splice(0)) res.destroy();
  await app?.close();
  delete process.env.GlobalPrefix;
});

const runBody = (extra: Record<string, unknown> = {}) => ({
  document: JSON.stringify({ id: 'wf', nodes: [] }),
  runtime: {},
  ...extra,
});

describe('workflow execution HTTP boundary', () => {
  it('starts a run with an explicit runtime and wipes the body before the access log', async () => {
    const response = await server()
      .post(`${API}/run`)
      .send(
        runBody({
          runtime: {
            githubToken: SECRET,
            ai: { baseUrl: 'https://ai.example/v1', apiKey: '', model: 'm', enableThinking: false },
            feishuAppId: '',
          },
          dateContext: { now: '2026-10-23T10:00:00+08:00', timeZone: 'Asia/Shanghai' },
        }),
      );
    await flush();

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      data: { runId: RUN_ID, accessToken: TOKEN, expiresAt: 3 },
      message: 'ok',
      code: 200,
    });
    // 全局 pipe 第二次转换后仍保持原类型与值
    const input = service.start.mock.calls[0][0] as WorkflowRunDto;
    expect(input.runtime.githubToken).toBe(SECRET);
    expect(input.runtime.ai).toMatchObject({ apiKey: '', enableThinking: false });
    expect(input.dateContext).toEqual({
      now: '2026-10-23T10:00:00+08:00',
      timeZone: 'Asia/Shanghai',
    });
    expect(allLogs()).toContain('"body":{}');
    expect(allLogs()).not.toContain(SECRET);
  });

  it('accepts a local-only run and a partial rerun with an empty previous list', async () => {
    expect((await server().post(`${API}/run`).send(runBody())).status).toBe(200);
    const rerun = await server()
      .post(`${API}/run`)
      .send(
        runBody({
          fromNodeId: 'text-1',
          previousOutputs: [{ nodeId: 'a.b:c-1', outputs: { text: 'x', nested: [{ n: 1 }] } }],
        }),
      );
    expect(rerun.status).toBe(200);
    expect(
      (
        await server()
          .post(`${API}/run`)
          .send(runBody({ fromNodeId: 'n', previousOutputs: [] }))
      ).status,
    ).toBe(200);
    expect(service.start).toHaveBeenCalledTimes(3);
  });

  const nested = (depth: number) => {
    let value: unknown = 'leaf';
    for (let index = 1; index < depth; index += 1) value = [value];
    return value;
  };

  it('accepts previous outputs at the depth limit and rejects one level deeper', async () => {
    const send = (depth: number) =>
      server()
        .post(`${API}/run`)
        .send(
          runBody({
            fromNodeId: 'n',
            previousOutputs: [{ nodeId: 'a', outputs: { deep: nested(depth) } }],
          }),
        );
    // outputs 对象本身为第 1 层，deep 的 nested(n) 再叠加 n-1 层数组
    expect((await send(WORKFLOW_EXECUTION_LIMITS.maxPreviousDepth)).status).toBe(200);
    expect((await send(WORKFLOW_EXECUTION_LIMITS.maxPreviousDepth + 1)).status).toBe(400);
  });

  it.each([
    ['missing runtime', { document: 'x' }],
    ['array runtime', runBody({ runtime: [] })],
    ['null runtime', runBody({ runtime: null })],
    ['unknown runtime field', runBody({ runtime: { token: SECRET } })],
    ['numeric credential', runBody({ runtime: { githubToken: 12345 } })],
    ['null credential', runBody({ runtime: { feishuAppId: null } })],
    ['credential with space', runBody({ runtime: { githubToken: `${SECRET} x` } })],
    ['string ai', runBody({ runtime: { ai: SECRET } })],
    ['unknown ai field', runBody({ runtime: { ai: { temperature: 1 } } })],
    ['string enableThinking', runBody({ runtime: { ai: { enableThinking: 'false' } } })],
    ['unknown top-level field', runBody({ extra: SECRET })],
    ['empty document', runBody({ document: '' })],
    ['numeric document', runBody({ document: 123 })],
    [
      'dateContext without offset',
      runBody({ dateContext: { now: '2026-10-23T10:00:00', timeZone: 'UTC' } }),
    ],
    [
      'dateContext unknown zone',
      runBody({ dateContext: { now: '2026-10-23T10:00:00Z', timeZone: 'Mars/Base' } }),
    ],
    [
      'dateContext extra',
      runBody({ dateContext: { now: '2026-10-23T10:00:00Z', timeZone: 'UTC', x: 1 } }),
    ],
    ['fromNodeId without previousOutputs', runBody({ fromNodeId: 'n' })],
    ['previousOutputs without fromNodeId', runBody({ previousOutputs: [] })],
    ['null previousOutputs', runBody({ fromNodeId: 'n', previousOutputs: null })],
    ['invalid fromNodeId', runBody({ fromNodeId: 'bad id', previousOutputs: [] })],
    ['long fromNodeId', runBody({ fromNodeId: 'a'.repeat(129), previousOutputs: [] })],
    [
      'array outputs',
      runBody({ fromNodeId: 'n', previousOutputs: [{ nodeId: 'a', outputs: [] }] }),
    ],
    [
      'extra previous field',
      runBody({ fromNodeId: 'n', previousOutputs: [{ nodeId: 'a', outputs: {}, x: 1 }] }),
    ],
    [
      'too many previous outputs',
      runBody({
        fromNodeId: 'n',
        previousOutputs: Array.from({ length: 101 }, (_, index) => ({
          nodeId: `n${index}`,
          outputs: {},
        })),
      }),
    ],
  ])('rejects run body with %s without leaking values', async (_name, body) => {
    const response = await server().post(`${API}/run`).send(body);
    await flush();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      data: null,
      message: WORKFLOW_EXECUTION_ERRORS.invalidRequest.message,
      code: 400,
    });
    expect(service.start).not.toHaveBeenCalled();
    expect(response.text + allLogs()).not.toContain(SECRET);
  });

  it('enforces the document UTF-8 byte budget and the cumulative previous-output budget', async () => {
    // 1.4M 个汉字字符数未超限，但 UTF-8 约 4.2 MiB
    const multibyte = await server()
      .post(`${API}/run`)
      .send(
        runBody({
          document: '汉'.repeat(Math.ceil(WORKFLOW_EXECUTION_LIMITS.maxDocumentBytes / 3) + 1),
        }),
      );
    expect(multibyte.status).toBe(400);
    const exact = await server()
      .post(`${API}/run`)
      .send(runBody({ document: 'a'.repeat(WORKFLOW_EXECUTION_LIMITS.maxDocumentBytes) }));
    expect(exact.status).toBe(200);

    const chunk = 'a'.repeat(11 * MIB);
    const overBudget = await server()
      .post(`${API}/run`)
      .send(
        runBody({
          fromNodeId: 'n',
          previousOutputs: ['a', 'b', 'c'].map((nodeId) => ({ nodeId, outputs: { text: chunk } })),
        }),
      );
    expect(overBudget.status).toBe(400);
    expect(service.start).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('rejects run bodies above the run budget and control bodies above 4 KiB without echoing', async () => {
    const huge = await server()
      .post(`${API}/run`)
      .set('Content-Type', 'application/json')
      .send(`{"document":"${SECRET}${'a'.repeat(WORKFLOW_EXECUTION_LIMITS.maxBodyBytes)}"}`);
    await flush();
    expect(huge.status).toBe(413);
    expect(huge.body.message).toBe(WORKFLOW_EXECUTION_ERRORS.tooLarge.message);

    for (const route of ['stop', 'confirm']) {
      const response = await server()
        .post(`${API}/${route}`)
        .set('X-Workflow-Token', TOKEN)
        .send({
          runId: RUN_ID,
          padding: `${SECRET}${'a'.repeat(WORKFLOW_EXECUTION_LIMITS.controlBodyBytes)}`,
        });
      expect(response.status).toBe(413);
    }
    await flush();
    expect(allLogs()).not.toContain(SECRET);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
  }, 60_000);

  it('returns 400 for malformed JSON and non-object bodies without echoing them', async () => {
    for (const payload of [`{"document":"${SECRET}`, `[${JSON.stringify(SECRET)}]`, 'null', '']) {
      const response = await server()
        .post(`${API}/run`)
        .set('Content-Type', 'application/json')
        .send(payload);
      await flush();
      expect(response.status).toBe(400);
      expect(response.body.data).toBeNull();
      expect(response.text + allLogs()).not.toContain(SECRET);
    }
  });

  it('applies strict DTOs to status, events, stop and confirm', async () => {
    const authed = { 'X-Workflow-Token': TOKEN };
    const queries = [
      ['status', {}],
      ['status', { runId: 'not-a-uuid' }],
      ['status', { runId: RUN_ID, extra: '1' }],
      ['status', { runId: RUN_ID, nodeId: '' }],
      ['status', { runId: RUN_ID, token: TOKEN }],
      ['status', `runId=${RUN_ID}&runId=${RUN_ID}`],
      ['status', 'runId[]=1'],
      ['events', {}],
      ['events', { runId: RUN_ID, nodeId: 'a' }],
    ] as const;
    for (const [route, query] of queries) {
      const response = await server().get(`${API}/${route}`).set(authed).query(query);
      expect(response.status, `${route} ${JSON.stringify(query)}`).toBe(400);
    }

    const bodies = [
      ['stop', {}],
      ['stop', { runId: RUN_ID, extra: 1 }],
      ['stop', { runId: [RUN_ID] }],
      ['confirm', { runId: RUN_ID, confirmationId: CONFIRMATION_ID }],
      ['confirm', { runId: RUN_ID, confirmationId: CONFIRMATION_ID, accepted: 'true' }],
      ['confirm', { runId: RUN_ID, confirmationId: CONFIRMATION_ID, accepted: 1 }],
      ['confirm', { runId: RUN_ID, confirmationId: 'nope', accepted: true }],
      ['confirm', { runId: RUN_ID, confirmationId: CONFIRMATION_ID, accepted: true, nodeId: 'a' }],
    ] as const;
    for (const [route, body] of bodies) {
      const response = await server().post(`${API}/${route}`).set(authed).send(body);
      expect(response.status, `${route} ${JSON.stringify(body)}`).toBe(400);
    }
    // POST 路由不接受 query
    expect(
      (
        await server()
          .post(`${API}/stop`)
          .set(authed)
          .query({ runId: RUN_ID })
          .send({ runId: RUN_ID })
      ).status,
    ).toBe(400);
    expect(service.status).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it('routes valid status, stop and confirm calls with the header token only', async () => {
    const authed = { 'X-Workflow-Token': TOKEN };
    const status = await server()
      .get(`${API}/status`)
      .set(authed)
      .query({ runId: RUN_ID, nodeId: 'text-1' });
    expect(status.status).toBe(200);
    expect(status.body.data.revision).toBe(1);
    expect(service.status).toHaveBeenCalledWith({ runId: RUN_ID, nodeId: 'text-1' }, TOKEN);

    expect((await server().post(`${API}/stop`).set(authed).send({ runId: RUN_ID })).status).toBe(
      200,
    );
    expect(service.stop).toHaveBeenCalledWith(RUN_ID, TOKEN);

    const confirmed = await server()
      .post(`${API}/confirm`)
      .set(authed)
      .send({ runId: RUN_ID, confirmationId: CONFIRMATION_ID, accepted: false });
    expect(confirmed.status).toBe(200);
    expect(service.confirm).toHaveBeenCalledWith(
      { runId: RUN_ID, confirmationId: CONFIRMATION_ID, accepted: false },
      TOKEN,
    );
    await flush();
    // 公共访问日志在 finish 时看不到 token（含 headers 与 rawHeaders）
    expect(allLogs()).not.toContain(TOKEN);
  });

  it('answers missing, malformed and wrong tokens with the same 404', async () => {
    const wrong = TOKEN.replace(/^a/, 'b');
    const attempts = [
      server().get(`${API}/status`).query({ runId: RUN_ID }),
      server().get(`${API}/status`).set('X-Workflow-Token', 'short').query({ runId: RUN_ID }),
      server().get(`${API}/status`).set('X-Workflow-Token', `${TOKEN}=`).query({ runId: RUN_ID }),
      server().get(`${API}/status`).set('X-Workflow-Token', wrong).query({ runId: RUN_ID }),
    ];
    const bodies: unknown[] = [];
    for (const attempt of attempts) {
      const response = await attempt;
      expect(response.status).toBe(404);
      bodies.push(response.body);
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(bodies[0]).toEqual({
      data: null,
      message: WORKFLOW_EXECUTION_ERRORS.notFound.message,
      code: 404,
    });
    // 格式错误的 token 不会到达服务；格式合法但错误的才由服务判定
    expect(service.status).toHaveBeenCalledTimes(1);
    expect(allLogs()).not.toContain(wrong);
  });

  it('does not accept the token from the query string and scrubs the query from the access log', async () => {
    const response = await server().get(`${API}/status`).query({ runId: RUN_ID, token: TOKEN });
    await flush();
    expect(response.status).toBe(400);
    expect(allLogs()).not.toContain(TOKEN);
  });

  it('returns only fixed messages for controlled and unexpected service errors', async () => {
    service.status.mockImplementationOnce(() => {
      throw new Error(`boom ${SECRET}`);
    });
    const unexpected = await server()
      .get(`${API}/status`)
      .set('X-Workflow-Token', TOKEN)
      .query({ runId: RUN_ID });
    await flush();
    expect(unexpected.status).toBe(500);
    expect(unexpected.body).toEqual({
      data: null,
      message: WORKFLOW_EXECUTION_ERRORS.internal.message,
      code: 500,
    });

    service.start.mockImplementationOnce(() => {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.capacity);
    });
    const capacity = await server()
      .post(`${API}/run`)
      .send(runBody({ runtime: { githubToken: SECRET } }));
    await flush();
    expect(capacity.status).toBe(429);
    expect(capacity.body.message).toBe(WORKFLOW_EXECUTION_ERRORS.capacity.message);
    expect(allLogs()).toContain('status=429 type=WorkflowExecutionException');
    expect(allLogs()).not.toContain(SECRET);
    expect(unexpected.text).not.toContain(SECRET);
  });
});

describe('workflow execution HTTP routing', () => {
  it.each([
    ['post', 'status', 'GET'],
    ['put', 'run', 'POST'],
    ['delete', 'stop', 'POST'],
    ['get', 'confirm', 'POST'],
    ['post', 'events', 'GET'],
  ] as const)('returns 405 for %s %s', async (method, route, allow) => {
    const response = await server()[method](`${API}/${route}`);
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe(allow);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['/other', '/run/extra', '/', '//run', '/status.json'])(
    'returns 404 for unknown subpath %s',
    async (sub) => {
      const response = await server().get(`${API}${sub}`);
      expect(response.status).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it.each([
    ['text/plain', `document=${SECRET}`],
    ['application/x-www-form-urlencoded', `document=${SECRET}`],
  ])('returns 415 for %s', async (contentType, payload) => {
    const response = await server()
      .post(`${API}/run`)
      .set('Content-Type', contentType)
      .send(payload);
    await flush();
    expect(response.status).toBe(415);
    expect(response.text + allLogs()).not.toContain(SECRET);
  });

  it('rejects GET requests that carry a body', async () => {
    const response = await server()
      .get(`${API}/status`)
      .query({ runId: RUN_ID })
      .set('X-Workflow-Token', TOKEN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: SECRET }));
    await flush();
    expect(response.status).toBe(400);
    expect(response.text + allLogs()).not.toContain(SECRET);
  });

  it('does not swallow the neighbouring workflow-directory and workflow-capabilities routes', async () => {
    for (const path of ['/api/workflow-directory/document', '/api/workflow-capabilities/ai-text']) {
      const response = await server().post(path).send({ hello: 'world' });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ received: { hello: 'world' } });
    }
    await flush();
    expect(allLogs()).toContain('"body":{"hello":"world"}');
  });

  it('mounts under the global prefix, ends the unprefixed path and keeps neighbouring routes', async () => {
    await app.close();
    app = await createApp('nest');

    const prefixed = await server().post(`/nest${API}/run`).send(runBody());
    expect(prefixed.status).toBe(200);
    const unprefixed = await server()
      .post(`${API}/run`)
      .send(runBody({ runtime: { githubToken: SECRET } }));
    await flush();
    expect(unprefixed.status).toBe(404);
    expect(unprefixed.headers['cache-control']).toBe('no-store');
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(allLogs()).not.toContain(SECRET);

    const neighbour = await server().post('/nest/api/workflow-directory/document').send({ a: 1 });
    expect(neighbour.status).toBe(201);
    expect(neighbour.body).toEqual({ received: { a: 1 } });
    expect(
      (
        await server()
          .get(`/nest${API}/status`)
          .set('X-Workflow-Token', TOKEN)
          .query({ runId: RUN_ID })
      ).status,
    ).toBe(200);
  });
});

describe('workflow execution cross-origin protection', () => {
  const post = (headers: Record<string, string>) =>
    server().post(`${API}/run`).set('Host', 'workflow.local').set(headers).send(runBody());

  it('accepts same-origin, effective-port equal and non-browser requests without CORS headers', async () => {
    for (const headers of [
      { Origin: 'http://workflow.local', 'Sec-Fetch-Site': 'same-origin' },
      { 'Sec-Fetch-Site': 'none' },
      {},
    ] as Record<string, string>[]) {
      const response = await post(headers);
      expect(response.status).toBe(200);
      // 公共 CORS 中间件写入的响应头必须被去除
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    }
    const explicitDefaultPort = await server()
      .post(`${API}/run`)
      .set('Host', 'workflow.local:80')
      .set('Origin', 'http://workflow.local')
      .send(runBody());
    expect(explicitDefaultPort.status).toBe(200);

    // 对照：同样的 CORS 配置对其他路由仍然生效
    const probe = await server()
      .post('/api/workflow-directory/document')
      .set('Origin', 'https://other.example')
      .send({});
    expect(probe.headers['access-control-allow-origin']).toBe('https://other.example');
  });

  it.each([
    ['foreign origin', { Origin: 'https://evil.example' }],
    ['https scheme against http', { Origin: 'https://workflow.local' }],
    ['origin with another port', { Origin: 'http://workflow.local:81' }],
    ['subdomain (same-site)', { Origin: 'http://api.workflow.local' }],
    ['opaque origin', { Origin: 'null' }],
    ['multiple origins', { Origin: 'http://workflow.local, http://evil.example' }],
    ['origin with path', { Origin: 'http://workflow.local/x' }],
    ['origin with userinfo', { Origin: 'http://user@workflow.local' }],
    ['empty origin', { Origin: '' }],
    ['cross-site fetch', { 'Sec-Fetch-Site': 'cross-site' }],
    ['same-site fetch', { 'Sec-Fetch-Site': 'same-site' }],
  ])(
    'rejects calls from %s before the service and without CORS headers',
    async (_name, headers) => {
      const write = await post(headers);
      await flush();
      expect(write.status).toBe(403);
      expect(write.body).toEqual({
        data: null,
        message: WORKFLOW_EXECUTION_ERRORS.forbiddenOrigin.message,
        code: 403,
      });
      expect(write.headers['access-control-allow-origin']).toBeUndefined();
      expect(write.headers['access-control-allow-credentials']).toBeUndefined();

      const read = await server()
        .get(`${API}/events`)
        .query({ runId: RUN_ID })
        .set('Host', 'workflow.local')
        .set('X-Workflow-Token', TOKEN)
        .set(headers);
      expect(read.status).toBe(403);
      expect(service.start).not.toHaveBeenCalled();
      expect(service.subscribe).not.toHaveBeenCalled();
    },
  );

  it('does not trust X-Forwarded headers when matching the origin', async () => {
    const response = await post({
      Origin: 'https://workflow.local',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'workflow.local',
    });
    expect(response.status).toBe(403);
  });
});

describe('workflow execution SSE over HTTP', () => {
  const path = `${API}/events?runId=${RUN_ID}`;
  const headers = { 'X-Workflow-Token': TOKEN };

  it('sends protective headers, the initial snapshot and unsubscribes without stopping the run', async () => {
    let push: Listener | undefined;
    const unsubscribe = vi.fn();
    service.subscribe.mockImplementationOnce((_runId, _token, listener) => {
      push = listener;
      listener(event('snapshot', 4));
      return unsubscribe;
    });

    const stream = await openStream(path, headers);
    expect(stream.res?.statusCode).toBe(200);
    expect(stream.res?.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(stream.res?.headers['cache-control']).toBe('no-store, no-transform');
    expect(stream.res?.headers['x-accel-buffering']).toBe('no');
    expect(stream.res?.headers['access-control-allow-origin']).toBeUndefined();
    await waitFor(() => stream.text.includes('event: snapshot'));
    expect(stream.text).toMatch(/^id: 4\nevent: snapshot\ndata: \{.*"revision":4.*\}\n\n$/);
    expect(stream.text).not.toContain(TOKEN);
    expect(service.subscribe).toHaveBeenCalledWith(RUN_ID, TOKEN, expect.any(Function));

    push?.(event('node-state', 5));
    await waitFor(() => stream.text.includes('id: 5\nevent: node-state'));
    expect(unsubscribe).not.toHaveBeenCalled();

    stream.res?.destroy();
    await waitFor(() => unsubscribe.mock.calls.length === 1);
    expect(service.stop).not.toHaveBeenCalled();
  });

  it('ends the stream after a run-finished event and unsubscribes once', async () => {
    let push: Listener | undefined;
    const unsubscribe = vi.fn();
    service.subscribe.mockImplementationOnce((_runId, _token, listener) => {
      push = listener;
      listener(event('snapshot', 1));
      return unsubscribe;
    });
    const stream = await openStream(path, headers);
    await waitFor(() => stream.text.includes('event: snapshot'));

    push?.(event('run-finished', 2, false));
    await waitFor(() => stream.ended);
    expect(stream.text).toContain('id: 2\nevent: run-finished');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('delivers a terminal initial snapshot and still unsubscribes after the synchronous push', async () => {
    const unsubscribe = vi.fn();
    service.subscribe.mockImplementationOnce((_runId, _token, listener) => {
      listener(event('snapshot', 9, false));
      return unsubscribe;
    });
    const stream = await openStream(path, headers);
    await waitFor(() => stream.ended);
    expect(stream.text).toContain('id: 9\nevent: snapshot');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores Last-Event-ID and always subscribes for a fresh snapshot', async () => {
    const stream = await openStream(path, { ...headers, 'Last-Event-ID': '99' });
    await waitFor(() => stream.text.includes('event: snapshot'));
    expect(service.subscribe).toHaveBeenCalledTimes(1);
    expect(stream.text).toContain('id: 1\n');
  });

  it('answers authorization and capacity failures with JSON before any stream header', async () => {
    const wrongToken = await server()
      .get(`${API}/events`)
      .query({ runId: RUN_ID })
      .set('X-Workflow-Token', TOKEN.replace(/^a/, 'b'));
    expect(wrongToken.status).toBe(404);
    expect(wrongToken.headers['content-type']).toContain('application/json');
    expect(wrongToken.body.message).toBe(WORKFLOW_EXECUTION_ERRORS.notFound.message);

    const missing = await server().get(`${API}/events`).query({ runId: RUN_ID });
    expect(missing.status).toBe(404);

    service.subscribe.mockImplementationOnce(() => {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.subscribers);
    });
    const full = await server().get(`${API}/events`).query({ runId: RUN_ID }).set(headers);
    expect(full.status).toBe(429);
    expect(full.headers['content-type']).toContain('application/json');
    expect(full.headers['cache-control']).toBe('no-store');
    expect(full.body.message).toBe(WORKFLOW_EXECUTION_ERRORS.subscribers.message);
  });
});

/** 响应替身：控制 write 返回值与 drain/close，验证订阅清理和慢消费者策略。 */
class FakeResponse extends EventEmitter {
  writes: string[] = [];
  writeResult = true;
  ended = false;
  destroyed = false;
  socket = { setNoDelay: vi.fn() };
  writeHead = vi.fn();
  flushHeaders = vi.fn();
  write = vi.fn((chunk: string) => {
    this.writes.push(chunk);
    return this.writeResult;
  });
  end = vi.fn(() => {
    this.ended = true;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit('close');
  });
}

describe('workflow execution SSE lifecycle', () => {
  const httpService = new WorkflowExecutionHttpService();
  const open = (res: FakeResponse, subscribe: (listener: Listener) => () => void) =>
    httpService.openEventStream(res as unknown as Response, subscribe);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sends heartbeat comments on the configured interval and clears the timer on close', () => {
    const res = new FakeResponse();
    const unsubscribe = vi.fn();
    open(res, (listener) => {
      listener(event('snapshot', 1));
      return unsubscribe;
    });
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(res.writes).toHaveLength(1);

    vi.advanceTimersByTime(WORKFLOW_EXECUTION_LIMITS.heartbeatMs);
    vi.advanceTimersByTime(WORKFLOW_EXECUTION_LIMITS.heartbeatMs);
    expect(res.writes.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(2);

    res.emit('close');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    res.emit('close');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps the heartbeat timer from holding the process open', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as never);
    const res = new FakeResponse();
    open(res, (listener) => {
      listener(event('snapshot', 1));
      return () => undefined;
    });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), WORKFLOW_EXECUTION_LIMITS.heartbeatMs);
    expect(unref).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    res.emit('close');
  });

  it('cleans up when the snapshot is terminal before unsubscribe is assigned', () => {
    const res = new FakeResponse();
    const unsubscribe = vi.fn();
    open(res, (listener) => {
      listener(event('snapshot', 3, false));
      return unsubscribe;
    });
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops writing and unsubscribes when the run finishes later', () => {
    const res = new FakeResponse();
    const unsubscribe = vi.fn();
    let push!: Listener;
    open(res, (listener) => {
      push = listener;
      listener(event('snapshot', 1));
      return unsubscribe;
    });
    push(event('run-finished', 2, false));
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    push(event('node-state', 3));
    expect(res.writes).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disconnects a slow consumer that has not drained by the next write', () => {
    const res = new FakeResponse();
    res.writeResult = false;
    const unsubscribe = vi.fn();
    let push!: Listener;
    open(res, (listener) => {
      push = listener;
      listener(event('snapshot', 1));
      return unsubscribe;
    });
    // 单帧超过写缓冲水位时 write 必然返回 false，首帧本身不算慢消费者
    expect(res.destroyed).toBe(false);

    push(event('node-state', 2));
    expect(res.destroyed).toBe(true);
    expect(res.writes).toHaveLength(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a consumer that drains between writes', () => {
    const res = new FakeResponse();
    res.writeResult = false;
    let push!: Listener;
    open(res, (listener) => {
      push = listener;
      listener(event('snapshot', 1));
      return () => undefined;
    });
    res.emit('drain');
    push(event('node-state', 2));
    expect(res.destroyed).toBe(false);
    expect(res.writes).toHaveLength(2);
    res.emit('close');
  });

  it('treats a heartbeat that finds the buffer still blocked as a slow consumer', () => {
    const res = new FakeResponse();
    res.writeResult = false;
    const unsubscribe = vi.fn();
    open(res, (listener) => {
      listener(event('snapshot', 1));
      return unsubscribe;
    });
    vi.advanceTimersByTime(WORKFLOW_EXECUTION_LIMITS.heartbeatMs);
    expect(res.destroyed).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases listeners and rethrows when subscription is refused', () => {
    const res = new FakeResponse();
    const refusal = new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.notFound);
    expect(() =>
      open(res, () => {
        throw refusal;
      }),
    ).toThrow(refusal);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
    expect(res.listenerCount('drain')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
