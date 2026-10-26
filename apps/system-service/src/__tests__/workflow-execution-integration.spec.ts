import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { HttpException, HttpStatus, ValidationPipe } from '@nestjs/common';
import type { ExceptionFilter, INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_EXECUTION_ERRORS } from '../constants/workflow-execution.constants';
import {
  WorkflowConfirmDto,
  WorkflowEventsQueryDto,
  WorkflowRunDto,
  WorkflowStatusQueryDto,
  WorkflowStopDto,
} from '../modules/workflow-execution/dto/workflow-execution.dto';
import { ContentCompareService } from '../modules/content-compare/content-compare.service';
import { WorkflowExecutionCapabilityService } from '../modules/workflow-execution/workflow-execution-capability.service';
import { WorkflowExecutionController } from '../modules/workflow-execution/workflow-execution.controller';
import { WorkflowExecutionEngineService } from '../modules/workflow-execution/workflow-execution-engine.service';
import { WorkflowExecutionHttpService } from '../modules/workflow-execution/workflow-execution-http.service';
import { WorkflowExecutionIoService } from '../modules/workflow-execution/workflow-execution-io.service';
import { WorkflowExecutionService } from '../modules/workflow-execution/workflow-execution.service';

const API = '/api/workflow';
const SECRET = 'FEISHU_SECRET_9f3a7c';
const WIKI_URL = 'https://tenant.feishu.cn/wiki/AbCdEf123?sheet=sheet1';
const CREDENTIAL_DEFAULTS = (
  createRequire(__filename)(resolve(__dirname, '../../public/js/workflow-capabilities.js')) as {
    CREDENTIAL_DEFAULTS: Record<string, unknown>;
  }
).CREDENTIAL_DEFAULTS;

interface State {
  nodeId: string;
  status: string;
  message: string;
  outputs?: Record<string, unknown> | null;
}
interface Snapshot {
  runId: string;
  revision: number;
  running: boolean;
  status: string;
  states: State[];
  confirmations?: { confirmationId: string; values: string[][]; range: string; wikiUrl: string }[];
}

const node = (id: string, type: string, version: number, config: object, name = id) => ({
  id,
  type,
  version,
  name,
  position: { x: 0, y: 0 },
  size: { width: 320, height: 360 },
  config,
});
const edge = (from: string, fromPort: string, to: string, toPort: string) => ({
  id: `${from}-${fromPort}-${to}-${toPort}`,
  source: { nodeId: from, port: fromPort },
  target: { nodeId: to, port: toPort },
});
const documentOf = (nodes: object[], edges: object[]) =>
  JSON.stringify({
    version: 1,
    id: 'integration',
    name: '集成',
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
  });

/** 纯本地：文本 -> 模板 -> 文本结果，不触发任何外部能力。 */
const LOCAL_DOCUMENT = documentOf(
  [
    node('start', 'start', 1, { ...CREDENTIAL_DEFAULTS }),
    node('text-1', 'text', 1, { text: 'hello 世界' }),
    node('template', 'text-template', 2, { template: 'Report: {{text}}' }),
    node('result', 'text-result', 1, { format: 'text' }),
  ],
  [
    edge('start', 'trigger', 'template', 'trigger'),
    edge('text-1', 'text', 'template', 'text'),
    edge('template', 'text', 'result', 'text'),
  ],
);

/** 受控挂起：写入节点在实际发送前必须等待人工确认；单元格总量超过 16 KiB 以覆盖大帧。 */
const BIG_CELL = 'x'.repeat(6000);
const WRITE_DOCUMENT = documentOf(
  [
    node('start', 'start', 1, { ...CREDENTIAL_DEFAULTS }),
    node('target', 'json-input', 1, { text: JSON.stringify({ wikiUrl: WIKI_URL, row: 2 }) }),
    node('values', 'json-input', 1, {
      text: JSON.stringify([[BIG_CELL, BIG_CELL, BIG_CELL, BIG_CELL]]),
    }),
    node('write', 'feishu-write-cells', 2, {
      startColumn: 'C',
      maxRows: 1,
      expectedColumns: 0,
      credentialRef: 'token-config',
    }),
  ],
  [
    edge('start', 'trigger', 'write', 'trigger'),
    edge('target', 'data', 'write', 'target'),
    edge('values', 'data', 'write', 'values'),
  ],
);

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

/** 外部能力替身：未被调用即证明没有外部访问；任何调用都会让对应断言失败。 */
const external = () => ({
  github: { query: vi.fn(() => Promise.reject(new Error('unexpected github'))) },
  ai: { generate: vi.fn(() => Promise.reject(new Error('unexpected ai'))) },
  feishu: {
    findRow: vi.fn(() => Promise.reject(new Error('unexpected feishu find'))),
    writeCells: vi.fn(
      async (_input: unknown, _signal: AbortSignal, beforeWrite?: () => void): Promise<unknown> => {
        beforeWrite?.();
        return { range: 'C2:F2', updatedCells: 4, status: 'written' };
      },
    ),
  },
});

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
}

let logger: CaptureLogger;
let doubles: ReturnType<typeof external>;
let service: WorkflowExecutionService;
let app: INestApplication;
const openStreams: IncomingMessage[] = [];

/** 真实服务链（执行服务、引擎、能力桥接、IO、内容对比）+ 真实 Controller/HttpService，按 bootstrap 顺序装配。 */
async function createApp(): Promise<INestApplication> {
  delete process.env.GlobalPrefix;
  emulateDecoratorMetadata();
  doubles = external();
  const io = new WorkflowExecutionIoService();
  const capabilities = new WorkflowExecutionCapabilityService(
    doubles.github as never,
    doubles.ai as never,
    doubles.feishu as never,
    new ContentCompareService(),
    io,
  );
  service = new WorkflowExecutionService(new WorkflowExecutionEngineService(capabilities), io);

  const moduleRef = await Test.createTestingModule({
    controllers: [WorkflowExecutionController],
    providers: [
      WorkflowExecutionHttpService,
      { provide: WorkflowExecutionService, useValue: service },
    ],
  }).compile();
  const nestApp = moduleRef.createNestApplication();
  nestApp.useLogger(logger);
  nestApp.enableCors({ origin: true, credentials: true });
  nestApp.get(WorkflowExecutionHttpService).mount(nestApp);
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
  await nestApp.listen(0);
  return nestApp;
}

const server = () => request(app.getHttpServer());

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** 启动一次执行并返回凭据。 */
async function start(document: string, runtime: object = {}) {
  const response = await server().post(`${API}/run`).send({ document, runtime });
  expect(response.status).toBe(200);
  return response.body.data as { runId: string; accessToken: string; expiresAt: number };
}

const statusOf = async (run: { runId: string; accessToken: string }, nodeId?: string) =>
  server()
    .get(`${API}/status`)
    .query({ runId: run.runId, ...(nodeId ? { nodeId } : {}) })
    .set('X-Workflow-Token', run.accessToken);

/** 通过真实 HTTP 连接读取 SSE，并解析完整事件帧。 */
async function openStream(run: { runId: string; accessToken: string }) {
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const state = { text: '', ended: false, res: undefined as IncomingMessage | undefined };
  await new Promise<void>((resolveHead, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: `${API}/events?runId=${run.runId}`,
        headers: { 'X-Workflow-Token': run.accessToken },
      },
      (res) => {
        state.res = res;
        openStreams.push(res);
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          state.text += chunk;
        });
        res.on('close', () => {
          state.ended = true;
        });
        resolveHead();
      },
    );
    req.on('error', reject);
    req.end();
  });
  const events = () =>
    state.text
      .split('\n\n')
      .filter((frame) => frame.startsWith('id: '))
      .map((frame) => {
        const [id, type, data] = frame.split('\n');
        return {
          id: Number(id.slice(4)),
          type: type.slice(7),
          data: JSON.parse(data.slice(6)) as Snapshot,
        };
      });
  return { state, events };
}

beforeEach(async () => {
  logger = new CaptureLogger();
  app = await createApp();
});

afterEach(async () => {
  for (const res of openStreams.splice(0)) res.destroy();
  service.onModuleDestroy();
  await app?.close();
  vi.restoreAllMocks();
});

describe('workflow execution real service over HTTP', () => {
  it('runs a pure local graph and exposes final outputs only through the authorized status', async () => {
    const run = await start(LOCAL_DOCUMENT);
    expect(run.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stream = await openStream(run);
    await waitFor(() => stream.state.ended);
    const events = stream.events();
    expect(events.at(-1)?.data).toMatchObject({ running: false, status: 'succeeded' });
    expect(events[0].type === 'snapshot' || events[0].type === 'run-finished').toBe(true);
    // revision 单调递增，事件与白名单快照不含节点输出与凭据
    const revisions = events.map((item) => item.id);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(stream.state.text).not.toContain('Report:');
    expect(stream.state.text).not.toContain(run.accessToken);

    const status = await statusOf(run);
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    const snapshot = status.body.data as Snapshot;
    expect(snapshot).toMatchObject({ runId: run.runId, running: false, status: 'succeeded' });
    const byId = Object.fromEntries(snapshot.states.map((state) => [state.nodeId, state]));
    expect(byId.template.outputs).toEqual({ text: 'Report: hello 世界' });
    expect(byId.result.outputs).toEqual({ text: 'Report: hello 世界' });
    expect(byId['text-1'].status).toBe('succeeded');

    const single = await statusOf(run, 'result');
    expect(single.body.data.states).toHaveLength(1);
    expect(single.body.data.states[0].outputs).toEqual({ text: 'Report: hello 世界' });
    expect((await statusOf(run, 'missing-node')).status).toBe(404);

    expect(doubles.github.query).not.toHaveBeenCalled();
    expect(doubles.ai.generate).not.toHaveBeenCalled();
    expect(doubles.feishu.findRow).not.toHaveBeenCalled();
    expect(doubles.feishu.writeCells).not.toHaveBeenCalled();
    expect(logger.lines.join('\n')).not.toContain(run.accessToken);
  });

  it('keeps the task isolated behind its token and rejects invalid graphs with the fixed message', async () => {
    const run = await start(LOCAL_DOCUMENT);
    const other = await start(LOCAL_DOCUMENT);
    const crossed = await server()
      .get(`${API}/status`)
      .query({ runId: run.runId })
      .set('X-Workflow-Token', other.accessToken);
    expect(crossed.status).toBe(404);
    expect(crossed.body.message).toBe(WORKFLOW_EXECUTION_ERRORS.notFound.message);

    const invalid = await server()
      .post(`${API}/run`)
      .send({ document: '{"version":1}', runtime: { feishuAppSecret: SECRET } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toBe(WORKFLOW_EXECUTION_ERRORS.invalidDocument.message);
    expect(invalid.text + logger.lines.join('\n')).not.toContain(SECRET);
  });

  describe('suspended write confirmation', () => {
    const runtime = { feishuAppId: 'cli_app', feishuAppSecret: SECRET };

    /** 等待写入节点挂起并取得本次确认。 */
    async function pending(run: { runId: string; accessToken: string }) {
      let snapshot: Snapshot | undefined;
      await waitFor(async () => {
        snapshot = (await statusOf(run)).body.data as Snapshot;
        return (snapshot.confirmations?.length ?? 0) === 1;
      });
      return snapshot!.confirmations![0];
    }

    it('delivers a >16 KiB confirmation frame once without reconnect loops, then ends after rejection', async () => {
      const subscribe = vi.spyOn(service, 'subscribe');
      const run = await start(WRITE_DOCUMENT, runtime);
      const confirmation = await pending(run);
      expect(JSON.stringify(confirmation.values).length).toBeGreaterThan(16 * 1024);

      const stream = await openStream(run);
      await waitFor(() => stream.events().length > 0);
      const initial = stream.events()[0];
      expect(initial.type).toBe('snapshot');
      expect(initial.data.confirmations?.[0].confirmationId).toBe(confirmation.confirmationId);
      expect(initial.data.running).toBe(true);
      // 大帧后连接仍然保持，并能接收后续增量
      expect(stream.state.ended).toBe(false);

      const rejected = await server()
        .post(`${API}/confirm`)
        .set('X-Workflow-Token', run.accessToken)
        .send({ runId: run.runId, confirmationId: confirmation.confirmationId, accepted: false });
      expect(rejected.status).toBe(200);
      await waitFor(() => stream.state.ended);
      expect(stream.events().at(-1)?.type).toBe('run-finished');
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(doubles.feishu.writeCells).not.toHaveBeenCalled();
      expect(stream.state.text + logger.lines.join('\n')).not.toContain(SECRET);

      const final = (await statusOf(run)).body.data as Snapshot;
      expect(final.running).toBe(false);
      expect(final.states.find((state) => state.nodeId === 'write')?.status).toBe('failed');

      // 已处理的确认不可重放
      const replay = await server()
        .post(`${API}/confirm`)
        .set('X-Workflow-Token', run.accessToken)
        .send({ runId: run.runId, confirmationId: confirmation.confirmationId, accepted: true });
      expect(replay.status).toBe(409);
      expect(doubles.feishu.writeCells).not.toHaveBeenCalled();
    });

    it('writes once only after an explicit accepted confirmation', async () => {
      const run = await start(WRITE_DOCUMENT, runtime);
      const confirmation = await pending(run);
      expect(doubles.feishu.writeCells).not.toHaveBeenCalled();

      const accepted = await server()
        .post(`${API}/confirm`)
        .set('X-Workflow-Token', run.accessToken)
        .send({ runId: run.runId, confirmationId: confirmation.confirmationId, accepted: true });
      expect(accepted.status).toBe(200);
      await waitFor(async () => !((await statusOf(run)).body.data as Snapshot).running);

      expect(doubles.feishu.writeCells).toHaveBeenCalledTimes(1);
      expect(doubles.feishu.writeCells.mock.calls[0][0]).toMatchObject({
        wikiUrl: WIKI_URL,
        range: 'C2:F2',
        runtime: { appId: 'cli_app', appSecret: SECRET },
      });
      const final = (await statusOf(run)).body.data as Snapshot;
      expect(final.status).toBe('succeeded');
      expect(final.states.find((state) => state.nodeId === 'write')?.outputs).toEqual({
        result: { range: 'C2:F2', updatedCells: 4, status: 'written' },
      });
    });

    it('does not cancel the run when the SSE connection drops, and stops it only on an explicit POST', async () => {
      const run = await start(WRITE_DOCUMENT, runtime);
      const confirmation = await pending(run);
      const stream = await openStream(run);
      await waitFor(() => stream.events().length > 0);

      stream.state.res?.destroy();
      await waitFor(() => stream.state.ended);
      await new Promise((done) => setTimeout(done, 50));
      const afterDrop = (await statusOf(run)).body.data as Snapshot;
      expect(afterDrop.running).toBe(true);
      expect(afterDrop.confirmations?.[0].confirmationId).toBe(confirmation.confirmationId);

      // 断开后退订释放名额：可再次订阅并获得新的快照
      const again = await openStream(run);
      await waitFor(() => again.events().length > 0);
      expect(again.events()[0].type).toBe('snapshot');
      expect(again.events()[0].data.running).toBe(true);

      const stopped = await server()
        .post(`${API}/stop`)
        .set('X-Workflow-Token', run.accessToken)
        .send({ runId: run.runId });
      expect(stopped.status).toBe(200);
      expect(stopped.body.data).toMatchObject({ running: false, status: 'cancelled' });
      await waitFor(() => again.state.ended);
      expect(again.events().at(-1)?.type).toBe('run-finished');

      // 停止后不再接受确认，也不会写入
      const late = await server()
        .post(`${API}/confirm`)
        .set('X-Workflow-Token', run.accessToken)
        .send({ runId: run.runId, confirmationId: confirmation.confirmationId, accepted: true });
      expect(late.status).toBe(409);
      expect(doubles.feishu.writeCells).not.toHaveBeenCalled();
      const final = (await statusOf(run)).body.data as Snapshot;
      expect(final).toMatchObject({ running: false, status: 'cancelled' });
      expect(JSON.stringify(final)).not.toContain(SECRET);
    });
  });
});
