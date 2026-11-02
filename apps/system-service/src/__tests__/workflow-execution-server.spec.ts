import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiTextClientException } from '../client/ai/ai-text-client.exception';
import type { AiTextClientService, AiTextRequest } from '../client/ai/ai-text-client.service';
import {
  WORKFLOW_EXECUTION_ERRORS,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_EXECUTION_MESSAGES,
} from '../constants/workflow-execution.constants';
import { ContentCompareService } from '../modules/content-compare/content-compare.service';
import { AiTextCapabilityService } from '../modules/workflow-capabilities/ai-text-capability.service';
import type { FeishuSheetCapabilityService } from '../modules/workflow-capabilities/feishu-sheet-capability.service';
import type { GithubCommitsCapabilityService } from '../modules/workflow-capabilities/github-commits-capability.service';
import type { WorkdayCalendarCapabilityService } from '../modules/workflow-capabilities/workday-calendar-capability.service';
import { WorkflowExecutionCapabilityService } from '../modules/workflow-execution/workflow-execution-capability.service';
import { WorkflowExecutionEngineService } from '../modules/workflow-execution/workflow-execution-engine.service';
import { WorkflowExecutionIoService } from '../modules/workflow-execution/workflow-execution-io.service';
import { WorkflowExecutionException } from '../modules/workflow-execution/workflow-execution.exception';
import { WorkflowExecutionService } from '../modules/workflow-execution/workflow-execution.service';
import type {
  ExecutionEvent,
  ExecutionSnapshot,
  WorkflowExecutionInput,
} from '../modules/workflow-execution/workflow-execution.types';

const T0 = Date.UTC(2026, 9, 23, 8, 0, 0);
const { activeTtlMs, resultTtlMs, confirmationTtlMs, maxActiveRuns } = WORKFLOW_EXECUTION_LIMITS;
const GITHUB_SECRET = 'ghp_GITHUB_SECRET_1';
const AI_SECRET = 'sk-AI_SECRET_2';
const FEISHU_SECRET = 'FEISHU_SECRET_3';
const WIKI_URL = 'https://example.feishu.cn/wiki/AbC123?sheet=sh1';

interface Run {
  runId: string;
  accessToken: string;
  expiresAt: number;
}
interface Gate<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** 可控 Promise：模拟忽略取消信号的外部依赖，由测试决定何时结清。 */
function deferred<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// setImmediate 不被假时钟接管，用来真实推进微任务与任务调度。
const tick = () => new Promise<void>((done) => setImmediate(done));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}

function expectFailure(action: () => unknown, error: { status: number; message: string }) {
  let caught: unknown;
  try {
    action();
  } catch (thrown) {
    caught = thrown;
  }
  expect(caught).toBeInstanceOf(WorkflowExecutionException);
  expect((caught as WorkflowExecutionException).message).toBe(error.message);
  expect((caught as WorkflowExecutionException).getStatus()).toBe(error.status);
}

// 合法文档构造：使用真实注册表的最新节点版本与默认配置。
const DEFAULTS: Record<string, { version: number; config: Record<string, unknown> }> = {
  start: { version: 1, config: {} },
  text: { version: 1, config: { text: '' } },
  'json-input': { version: 1, config: { text: '{}' } },
  'json-parse': { version: 1, config: {} },
  'json-compare': { version: 1, config: {} },
  'env-compare': { version: 1, config: {} },
  'diff-result': { version: 1, config: {} },
  'text-result': { version: 1, config: { format: 'text' } },
  'text-template': { version: 2, config: { template: '{{text}}' } },
  'date-range': { version: 1, config: { period: 'last-week', since: '', until: '' } },
  'ai-text': {
    version: 2,
    config: { systemPrompt: '', contextWindowTokens: 100000, credentialRef: 'token-config' },
  },
  'feishu-write-cells': {
    version: 2,
    config: { startColumn: 'C', maxRows: 1, expectedColumns: 0, credentialRef: 'token-config' },
  },
};
type NodeSpec = [id: string, type: string, config?: Record<string, unknown>];

/** links 的两端写作 "节点.端口"。 */
function flow(nodes: NodeSpec[], links: [string, string][]): string {
  return JSON.stringify({
    version: 1,
    id: 'server-flow',
    name: '服务端执行',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: nodes.map(([id, type, config]) => ({
      id,
      type,
      version: DEFAULTS[type].version,
      name: id,
      position: { x: 0, y: 0 },
      size: { width: 320, height: 240 },
      config: { ...DEFAULTS[type].config, ...config },
    })),
    edges: links.map(([from, to], index) => {
      const [sourceNode, sourcePort] = from.split('.');
      const [targetNode, targetPort] = to.split('.');
      return {
        id: `e-${index}`,
        source: { nodeId: sourceNode, port: sourcePort },
        target: { nodeId: targetNode, port: targetPort },
      };
    }),
  });
}

/** 纯本地：JSON 与 ENV 对比都走真实 ContentCompareService。 */
const localGraph = () =>
  flow(
    [
      ['start', 'start'],
      ['jl', 'text', { text: '{"a":1,"b":[1,2]}' }],
      ['jr', 'text', { text: '{"a":2,"b":[1,2]}' }],
      ['jc', 'json-compare'],
      ['jd', 'diff-result'],
      ['el', 'text', { text: 'A=1\nB=2' }],
      ['er', 'text', { text: 'A=1\nB=3' }],
      ['ec', 'env-compare'],
      ['ed', 'diff-result'],
    ],
    [
      ['start.trigger', 'jc.trigger'],
      ['jl.text', 'jc.a'],
      ['jr.text', 'jc.b'],
      ['jc.diff', 'jd.diff'],
      ['start.trigger', 'ec.trigger'],
      ['el.text', 'ec.a'],
      ['er.text', 'ec.b'],
      ['ec.diff', 'ed.diff'],
    ],
  );

/** 单个 AI 节点，下游文本结果用于验证被阻止的分发。 */
const aiGraph = () =>
  flow(
    [
      ['start', 'start'],
      ['seed', 'text', { text: 'prompt text' }],
      ['ai', 'ai-text'],
      ['out', 'text-result'],
    ],
    [
      ['start.trigger', 'ai.trigger'],
      ['seed.text', 'ai.prompt'],
      ['ai.text', 'out.text'],
    ],
  );

/** up 为任务边界（AI），target 为局部运行起点。 */
const chainGraph = () =>
  flow(
    [
      ['start', 'start'],
      ['seed', 'text', { text: 'seed text' }],
      ['up', 'ai-text'],
      ['target', 'text-template', { template: 'T:{{text}}' }],
      ['after', 'text-result'],
    ],
    [
      ['start.trigger', 'up.trigger'],
      ['seed.text', 'up.prompt'],
      ['start.trigger', 'target.trigger'],
      ['up.text', 'target.text'],
      ['target.text', 'after.text'],
    ],
  );

const writeNodes: NodeSpec[] = [
  ['tgt', 'json-input', { text: JSON.stringify({ wikiUrl: WIKI_URL, row: 3 }) }],
];
/** 目标与矩阵均为静态 JSON，写入节点直接进入确认。 */
const writeGraph = () =>
  flow(
    [
      ['start', 'start'],
      ...writeNodes,
      ['vals', 'json-input', { text: '[["a",1]]' }],
      ['write', 'feishu-write-cells'],
    ],
    [
      ['start.trigger', 'write.trigger'],
      ['tgt.data', 'write.target'],
      ['vals.data', 'write.values'],
    ],
  );

/** 矩阵来自 AI 文本，使确认请求可以晚于任务开始很久才出现。 */
const lateWriteGraph = () =>
  flow(
    [
      ['start', 'start'],
      ['seed', 'text', { text: 'rows' }],
      ['ai', 'ai-text'],
      ['parse', 'json-parse'],
      ...writeNodes,
      ['write', 'feishu-write-cells'],
    ],
    [
      ['start.trigger', 'ai.trigger'],
      ['seed.text', 'ai.prompt'],
      ['start.trigger', 'parse.trigger'],
      ['ai.text', 'parse.text'],
      ['start.trigger', 'write.trigger'],
      ['tgt.data', 'write.target'],
      ['parse.data', 'write.values'],
    ],
  );

const dateGraph = () =>
  flow(
    [
      ['start', 'start'],
      ['d', 'date-range'],
      ['tpl', 'text-template', { template: '{{context.startDate}}~{{context.endDate}}' }],
    ],
    [
      ['start.trigger', 'tpl.trigger'],
      ['d.range', 'tpl.context'],
    ],
  );

const defaultRuntime = () => ({
  githubToken: GITHUB_SECRET,
  ai: { baseUrl: 'https://ai.example.test/v1', apiKey: AI_SECRET, model: 'model-1' },
  feishuAppId: 'cli_app',
  feishuAppSecret: FEISHU_SECRET,
});

/** 真实 Service/Engine/Capability/Io 协作，仅外部能力服务使用受控替身。 */
function createHarness() {
  const aiGates: Gate<string>[] = [];
  const writeGates: Gate<void>[] = [];
  const generate = vi.fn((_request: AiTextRequest) => {
    const gate = deferred<string>();
    aiGates.push(gate);
    return gate.promise;
  });
  const writeCells = vi.fn(
    async (
      input: { range: string; values: unknown[][] },
      _signal: AbortSignal,
      beforeWrite?: () => void,
    ) => {
      beforeWrite?.(); // 与真实实现一致：写请求发出前登记不确定标志
      const gate = deferred<void>();
      writeGates.push(gate);
      await gate.promise;
      return {
        range: input.range,
        updatedCells: input.values.length * input.values[0].length,
        status: 'written' as const,
      };
    },
  );
  const github = { query: vi.fn() };
  const calendar = { query: vi.fn() };
  const feishu = { findRow: vi.fn(), writeCells };
  const compare = new ContentCompareService();
  const io = new WorkflowExecutionIoService();
  const ai = new AiTextCapabilityService({ generate } as unknown as AiTextClientService);
  const capability = new WorkflowExecutionCapabilityService(
    github as unknown as GithubCommitsCapabilityService,
    ai,
    feishu as unknown as FeishuSheetCapabilityService,
    compare,
    io,
    calendar as unknown as WorkdayCalendarCapabilityService,
  );
  const service = new WorkflowExecutionService(new WorkflowExecutionEngineService(capability), io);
  const internals = service as unknown as {
    records: Map<string, unknown>;
    residualReservations: Map<string, number>;
    subscribers: number;
  };
  const status = (run: Run, nodeId?: string) =>
    service.status({ runId: run.runId, nodeId }, run.accessToken);
  const start = (document: string, extra: Partial<WorkflowExecutionInput> = {}): Run =>
    service.start({ document, runtime: defaultRuntime(), ...extra });
  const stateOf = (snapshot: ExecutionSnapshot, nodeId: string) => {
    const state = snapshot.states.find((item) => item.nodeId === nodeId);
    if (!state) throw new Error(`缺少节点状态：${nodeId}`);
    return state;
  };
  const finished = (run: Run) =>
    until(() => !status(run).running, `任务 ${run.runId} 结束`).then(() => status(run));
  const aiCalls = (count: number) =>
    until(() => generate.mock.calls.length >= count, `AI 调用达到 ${count} 次`);
  const writeCalls = (count: number) =>
    until(() => writeCells.mock.calls.length >= count, `写入调用达到 ${count} 次`);
  const confirmationOf = async (run: Run) => {
    await until(() => (status(run).confirmations?.length ?? 0) > 0, '出现写入确认');
    return status(run).confirmations![0];
  };
  return {
    service,
    io,
    calendar,
    compare,
    generate,
    writeCells,
    aiGates,
    writeGates,
    internals,
    status,
    start,
    stateOf,
    finished,
    aiCalls,
    writeCalls,
    confirmationOf,
  };
}
type Harness = ReturnType<typeof createHarness>;

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({
    now: T0,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  h = createHarness();
});
afterEach(async () => {
  for (const gate of h.aiGates) gate.resolve('late');
  for (const gate of h.writeGates) gate.resolve();
  h.service.onModuleDestroy();
  for (let index = 0; index < 5; index += 1) await tick();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('纯本地整图与订阅', () => {
  it('JSON/ENV 对比直接走 ContentCompareService，事件不含输出与凭据且监听器抛错不影响任务', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止外网'));
    const compareSpy = vi.spyOn(h.compare, 'compare');
    const run = h.start(localGraph());
    const events: ExecutionEvent[] = [];
    let badCalls = 0;
    h.service.subscribe(run.runId, run.accessToken, () => {
      badCalls += 1;
      if (badCalls >= 2) throw new Error('listener boom');
    });
    h.service.subscribe(run.runId, run.accessToken, (event) => events.push(event));

    const final = await h.finished(run);

    expect(final.status).toBe('succeeded');
    expect(final.states.every((state) => state.status === 'succeeded')).toBe(true);
    expect(h.stateOf(final, 'jd').outputs).toMatchObject({
      diff: { format: 'json', stats: { modified: 1 } },
    });
    expect(h.stateOf(final, 'ed').outputs).toMatchObject({
      diff: { format: 'env', stats: { modified: 1 } },
    });
    expect(compareSpy.mock.calls.map(([input]) => input.format).sort()).toEqual(['env', 'json']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();

    expect(events[0].type).toBe('snapshot');
    expect(events.at(-1)).toMatchObject({
      type: 'run-finished',
      data: { running: false, status: 'succeeded' },
    });
    expect(events.some((event) => event.type === 'node-state')).toBe(true);
    const revisions = events.map((event) => event.data.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
    const wire = JSON.stringify(events);
    for (const forbidden of [
      '"outputs"',
      'leftText',
      run.accessToken,
      GITHUB_SECRET,
      AI_SECRET,
      FEISHU_SECRET,
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    expect(badCalls).toBe(2); // 抛错后被独立退订，不再收到后续事件
    expect(h.internals.subscribers).toBe(0);
  });

  it('日期节点需要本次 dateContext 且创建后不受调用方对象修改影响', async () => {
    expectFailure(() => h.start(dateGraph()), WORKFLOW_EXECUTION_ERRORS.invalidDateContext);
    for (const dateContext of [
      { now: '2026-10-23T08:00:00Z', timeZone: 'Not/AZone' },
      { now: '2026-10-23 08:00', timeZone: 'Asia/Shanghai' },
    ]) {
      expectFailure(
        () => h.start(dateGraph(), { dateContext }),
        WORKFLOW_EXECUTION_ERRORS.invalidDateContext,
      );
    }
    expect(h.internals.records.size).toBe(0);

    const dateContext = { now: '2026-10-23T08:00:00Z', timeZone: 'Asia/Shanghai' };
    const run = h.start(dateGraph(), { dateContext });
    dateContext.now = '2020-01-01T00:00:00Z';
    const final = await h.finished(run);
    expect(h.stateOf(final, 'tpl').outputs).toEqual({ text: '2026-10-12~2026-10-18' });
  });
});

describe('日期范围联网开关的统一任务执行', () => {
  const calendar = {
    region: 'CN',
    timeZone: 'Asia/Shanghai',
    startDate: '2026-10-10',
    endDate: '2026-10-11',
    workdays: ['2026-10-10'],
    days: [
      { date: '2026-10-10', isWorkday: true, reason: 'makeup-workday', name: '国庆节' },
      { date: '2026-10-11', isWorkday: false, reason: 'weekend', name: '' },
    ],
    sources: [
      {
        year: 2026,
        url: 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json',
        papers: ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'],
      },
    ],
  };

  /** 仍是原日期节点；联网结果沿既有 range 端口进入模板和 AI。 */
  function graph(): string {
    const doc = JSON.parse(
      flow(
        [
          ['start', 'start'],
          ['d', 'date-range', { period: 'custom', since: '2026-10-10', until: '2026-10-11' }],
          ['tpl', 'text-template', { template: '工作日：{{context.workdayCalendar.workdays}}' }],
          ['ai', 'ai-text'],
          ['out', 'text-result'],
        ],
        [
          ['start.trigger', 'tpl.trigger'],
          ['d.range', 'tpl.context'],
          ['tpl.text', 'ai.prompt'],
          ['ai.text', 'out.text'],
        ],
      ),
    );
    const date = doc.nodes.find((node: { id: string }) => node.id === 'd');
    date.version = 2;
    date.config.includeWorkdays = true;
    return JSON.stringify(doc);
  }

  const extra = { dateContext: { now: '2026-10-23T08:00:00Z', timeZone: 'Asia/Shanghai' } };

  it('直接调用日历 Service 且只提交地区和日期，不通过 HTTP 回环或转发凭据', async () => {
    h.calendar.query.mockResolvedValue(calendar);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不允许真实外部调用'));
    const run = h.start(graph(), extra);
    await h.aiCalls(1);
    expect(h.calendar.query).toHaveBeenCalledOnce();
    expect(h.calendar.query.mock.calls[0][0]).toEqual({
      region: 'CN',
      startDate: '2026-10-10',
      endDate: '2026-10-11',
    });
    expect(h.calendar.query.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(h.generate.mock.calls[0][0].prompt).toBe('工作日：["2026-10-10"]');
    expect(fetch).not.toHaveBeenCalled();
    h.aiGates[0].resolve('仅安排调休工作日的周报');
    const snapshot = await h.finished(run);
    expect(h.stateOf(snapshot, 'd').status).toBe('succeeded');
    expect(h.stateOf(snapshot, 'out').outputs).toEqual({ text: '仅安排调休工作日的周报' });
  });

  it('日历失败使原日期节点失败，阻止 AI 和其下游运行', async () => {
    h.calendar.query.mockRejectedValue(new Error('日历不可用'));
    const run = h.start(graph(), extra);
    const snapshot = await h.finished(run);
    expect(h.stateOf(snapshot, 'd').status).toBe('failed');
    expect(h.stateOf(snapshot, 'd').outputs).toBeNull();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.writeCells).not.toHaveBeenCalled();
  });

  it('停止后不接收忽略信号的迟到日历，也不启动 AI', async () => {
    const pending = deferred<typeof calendar>();
    h.calendar.query.mockImplementation(() => pending.promise);
    const run = h.start(graph(), extra);
    await until(() => h.calendar.query.mock.calls.length === 1, '日历请求开始');
    h.service.stop(run.runId, run.accessToken);
    pending.resolve(calendar);
    await tick();
    const snapshot = await h.finished(run);
    expect(h.stateOf(snapshot, 'd').outputs).toBeNull();
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe('任务令牌隔离', () => {
  it('错误令牌与不存在任务统一 404，且不影响真实任务；订阅断开不取消运行', async () => {
    const run = h.start(aiGraph());
    const other = h.start(localGraph());
    await h.aiCalls(1);
    const unknownRun = '00000000-0000-4000-8000-000000000000';

    for (const token of [other.accessToken, '', 'x'.repeat(43), undefined as unknown as string]) {
      expectFailure(
        () => h.service.status({ runId: run.runId }, token),
        WORKFLOW_EXECUTION_ERRORS.notFound,
      );
      expectFailure(() => h.service.stop(run.runId, token), WORKFLOW_EXECUTION_ERRORS.notFound);
      expectFailure(
        () => h.service.confirm({ runId: run.runId, confirmationId: 'any', accepted: true }, token),
        WORKFLOW_EXECUTION_ERRORS.notFound,
      );
      expectFailure(
        () => h.service.subscribe(run.runId, token, () => undefined),
        WORKFLOW_EXECUTION_ERRORS.notFound,
      );
    }
    expectFailure(
      () => h.service.status({ runId: unknownRun }, run.accessToken),
      WORKFLOW_EXECUTION_ERRORS.notFound,
    );
    expectFailure(() => h.status(run, 'ghost-node'), WORKFLOW_EXECUTION_ERRORS.notFound);
    expect(h.status(run).running).toBe(true);
    expect(h.status(run, 'ai').states.map((state) => state.nodeId)).toEqual(['ai']);

    const events: ExecutionEvent[] = [];
    const unsubscribe = h.service.subscribe(run.runId, run.accessToken, (event) =>
      events.push(event),
    );
    unsubscribe();
    unsubscribe(); // 重复退订幂等，不重复扣减订阅计数
    expect(h.internals.subscribers).toBe(0);
    await tick();
    expect(h.status(run).running).toBe(true);
    expect(h.generate.mock.calls[0][0].signal?.aborted).toBe(false);

    h.aiGates[0].resolve('answer');
    const final = await h.finished(run);
    expect(final.status).toBe('succeeded');
    expect(h.stateOf(final, 'out').outputs).toEqual({ text: 'answer' });
    expect(events).toHaveLength(1); // 退订后只有订阅时的快照
  });
});

describe('AI 能力包装', () => {
  it('runtime 在创建时冻结，调用方之后修改不会影响下游模型请求', async () => {
    const runtime = defaultRuntime();
    const run = h.service.start({ document: aiGraph(), runtime });
    runtime.ai.apiKey = 'MUTATED';
    runtime.ai.baseUrl = 'https://evil.example.test';
    await h.aiCalls(1);
    expect(h.generate.mock.calls[0][0]).toMatchObject({
      baseUrl: 'https://ai.example.test/v1',
      apiKey: AI_SECRET,
      model: 'model-1',
      prompt: 'prompt text',
    });
    h.aiGates[0].resolve('ok');
    expect((await h.finished(run)).status).toBe('succeeded');
  });

  it('未知错误不泄漏原文与凭据，受控错误仅在不含秘密时透出', async () => {
    const cases: [Error, string][] = [
      [new Error(`socket hang up ${AI_SECRET} http://internal.host/v1`), '节点执行失败'],
      [
        new AiTextClientException(`bad key ${AI_SECRET}`, 401),
        '能力请求失败，请检查参数、凭据或稍后重试。',
      ],
      [
        new AiTextClientException('AI 请求异常，请检查网络、baseUrl 和服务端可用性。', 502),
        'AI 请求异常',
      ],
    ];
    for (const [error, expected] of cases) {
      h.generate.mockImplementationOnce(() => Promise.reject(error));
      const run = h.start(aiGraph());
      const final = await h.finished(run);
      expect(final.status).toBe('failed');
      expect(h.stateOf(final, 'ai')).toMatchObject({ status: 'failed', outputs: null });
      expect(h.stateOf(final, 'ai').message).toContain(expected);
      expect(h.stateOf(final, 'out').status).toBe('skipped');
      const wire = JSON.stringify(final);
      for (const leaked of [AI_SECRET, 'socket hang up', 'internal.host', 'bad key']) {
        expect(wire).not.toContain(leaked);
      }
    }
  });

  it('模型文本反射任一凭据组的秘密都被阻止，下游节点不会收到', async () => {
    for (const secret of [GITHUB_SECRET, FEISHU_SECRET, AI_SECRET]) {
      const run = h.start(aiGraph());
      await h.aiCalls(h.generate.mock.calls.length + 1);
      h.aiGates.at(-1)!.resolve(`reflected ${secret}`);
      const final = await h.finished(run);
      expect(h.stateOf(final, 'ai')).toMatchObject({ status: 'failed', outputs: null });
      expect(h.stateOf(final, 'out')).toMatchObject({ status: 'skipped', outputs: null });
      expect(JSON.stringify(final)).not.toContain(secret);
    }
  });

  it('开始节点凭据按 trim 后的真实值拦截，含引号与反斜线的秘密不因 JSON 转义漏检', async () => {
    const reflect = async (
      secret: string,
      options: {
        startConfig?: Record<string, unknown>;
        runtime: Record<string, unknown>;
        reflected: string;
      },
    ) => {
      const run = h.start(
        flow(
          [
            ['start', 'start', options.startConfig],
            ['seed', 'text', { text: 'prompt text' }],
            ['ai', 'ai-text'],
            ['out', 'text-result'],
          ],
          [
            ['start.trigger', 'ai.trigger'],
            ['seed.text', 'ai.prompt'],
            ['ai.text', 'out.text'],
          ],
        ),
        { runtime: options.runtime },
      );
      await h.aiCalls(h.generate.mock.calls.length + 1);
      h.aiGates.at(-1)!.resolve(`reflected ${options.reflected}`);
      const final = await h.finished(run);
      expect(h.stateOf(final, 'ai'), `反射 ${secret}`).toMatchObject({
        status: 'failed',
        outputs: null,
      });
      expect(h.stateOf(final, 'out')).toMatchObject({ status: 'skipped', outputs: null });
      expect(JSON.stringify(final)).not.toContain('reflected');
      expect(JSON.stringify(final)).not.toContain(options.reflected);
    };
    const { ai } = defaultRuntime();

    // 开始节点凭据实际会被 trim 使用，反射去空格后的同值必须被拒绝
    await reflect('start 配置', {
      startConfig: { githubToken: '  github-secret  ' },
      runtime: { ai },
      reflected: 'github-secret',
    });
    // JSON.stringify 会转义引号和反斜线，不能用序列化串做包含判断
    await reflect('引号', {
      runtime: { ai, githubToken: 'github-"secret"' },
      reflected: 'github-"secret"',
    });
    await reflect('反斜线', {
      runtime: { ai, githubToken: 'github\\secret' },
      reflected: 'github\\secret',
    });
    await reflect('开始节点引号', {
      startConfig: { githubToken: 'gh"quote\\' },
      runtime: { ai },
      reflected: 'gh"quote\\',
    });
  });

  it('嵌套 JSON 输出的键与值都按真实字符串检查，下游不会收到', async () => {
    const secrets = ['github-secret', 'github-"secret"', 'github\\secret'];
    const payloads = (secret: string): [string, unknown][] => [
      ['对象值', { a: { b: `prefix ${secret} suffix` } }],
      ['数组元素', { list: [1, ['x', secret]] }],
      ['对象键', { outer: { [secret]: 1 } }],
    ];
    for (const secret of secrets) {
      for (const [label, payload] of payloads(secret)) {
        const run = h.start(
          flow(
            [
              ['start', 'start'],
              ['ji', 'json-input', { text: JSON.stringify(payload) }],
              ['tpl', 'text-template', { template: '{{json:context}}' }],
            ],
            [
              ['start.trigger', 'tpl.trigger'],
              ['ji.data', 'tpl.context'],
            ],
          ),
          { runtime: { githubToken: secret } },
        );
        const final = await h.finished(run);
        expect(h.stateOf(final, 'ji'), `${label} ${secret}`).toMatchObject({
          status: 'failed',
          message: '节点输出包含本次执行凭据，已拒绝分发。',
          outputs: null,
        });
        expect(h.stateOf(final, 'tpl')).toMatchObject({ status: 'skipped', outputs: null });
        expect(JSON.stringify(final)).not.toContain(JSON.stringify(secret).slice(1, -1));
      }
    }
  });
});

describe('订阅计数', () => {
  it('同一回调重复订阅后各自退订，全局订阅计数回到 0 且其余任务仍可订阅', async () => {
    const runs = [h.start(aiGraph()), h.start(aiGraph()), h.start(aiGraph())];
    const shared = vi.fn();
    const unsubscribes = [1, 2, 3].map(() =>
      h.service.subscribe(runs[0].runId, runs[0].accessToken, shared),
    );
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes[0](); // 重复退订必须幂等
    expect(h.internals.subscribers).toBe(0);

    // 全局上限 12：三个任务各 4 个互不相同的订阅都应成功，第 5 个才受每任务上限拒绝
    const listeners = runs.map((run) =>
      [1, 2, 3, 4].map(() => h.service.subscribe(run.runId, run.accessToken, vi.fn())),
    );
    expect(h.internals.subscribers).toBe(WORKFLOW_EXECUTION_LIMITS.maxSubscribers);
    expectFailure(
      () => h.service.subscribe(runs[1].runId, runs[1].accessToken, vi.fn()),
      WORKFLOW_EXECUTION_ERRORS.subscribers,
    );
    for (const unsubscribe of listeners.flat()) unsubscribe();
    expect(h.internals.subscribers).toBe(0);
  });

  it('同一回调的每次注册都独立计入每任务上限，全部退订后归零', () => {
    const run = h.start(aiGraph());
    const shared = vi.fn();
    const { maxSubscribersPerRun } = WORKFLOW_EXECUTION_LIMITS;
    const unsubscribes = Array.from({ length: maxSubscribersPerRun }, () =>
      h.service.subscribe(run.runId, run.accessToken, shared),
    );
    expect(h.internals.subscribers).toBe(maxSubscribersPerRun);
    expectFailure(
      () => h.service.subscribe(run.runId, run.accessToken, shared),
      WORKFLOW_EXECUTION_ERRORS.subscribers,
    );
    for (const unsubscribe of unsubscribes) unsubscribe();
    expect(h.internals.subscribers).toBe(0);
  });

  it('同一回调重复订阅的任务结束时一并结算订阅计数', async () => {
    const run = h.start(localGraph());
    const shared = vi.fn();
    h.service.subscribe(run.runId, run.accessToken, shared);
    h.service.subscribe(run.runId, run.accessToken, shared);
    await h.finished(run);
    expect(h.internals.subscribers).toBe(0);

    const other = h.start(aiGraph());
    for (let index = 0; index < WORKFLOW_EXECUTION_LIMITS.maxSubscribersPerRun; index += 1) {
      h.service.subscribe(other.runId, other.accessToken, vi.fn());
    }
    expect(h.internals.subscribers).toBe(WORKFLOW_EXECUTION_LIMITS.maxSubscribersPerRun);
  });
});

describe('全局活动任务容量', () => {
  it('停止后忽略取消的调用仍占用容量，原 Promise 结清后才恢复', async () => {
    const runs = [h.start(aiGraph()), h.start(aiGraph()), h.start(aiGraph())];
    await h.aiCalls(maxActiveRuns);
    expectFailure(() => h.start(aiGraph()), WORKFLOW_EXECUTION_ERRORS.capacity);

    for (const run of runs) {
      const snapshot = h.service.stop(run.runId, run.accessToken);
      expect(snapshot).toMatchObject({ running: false, status: 'cancelled' });
      expect(h.stateOf(snapshot, 'ai').message).toBe(WORKFLOW_EXECUTION_MESSAGES.stopped);
    }
    expect(h.generate.mock.calls.every(([request]) => request.signal?.aborted)).toBe(true);
    expect([...h.io.pendingRuns()].sort()).toEqual(runs.map((run) => run.runId).sort());
    for (let index = 0; index < 5; index += 1) {
      expectFailure(() => h.start(aiGraph()), WORKFLOW_EXECUTION_ERRORS.capacity);
    }
    expect(h.internals.records.size).toBe(maxActiveRuns);

    h.aiGates[0].resolve('late');
    await until(() => !h.io.pendingRuns().has(runs[0].runId), '首个调用结清');
    const replacement = h.start(aiGraph()); // 仍有两个未结清所有者，恢复一个名额
    expect(h.io.pendingRuns().has(runs[0].runId)).toBe(false);
    expectFailure(() => h.start(aiGraph()), WORKFLOW_EXECUTION_ERRORS.capacity);
    expect(h.status(replacement).running).toBe(true);
    expect(h.status(runs[0]).status).toBe('cancelled'); // 迟到结果不改写已停止的任务
    expect(h.stateOf(h.status(runs[0]), 'ai').outputs).toBeNull();
  });
});

describe('局部运行 runFrom', () => {
  const previous = (nodeId: string, outputs: Record<string, unknown>) => ({ nodeId, outputs });

  it('只使用本次显式提供的边界输出，不重新调用上游也不依赖上次记录', async () => {
    const document = chainGraph();
    const first = h.start(document);
    await h.aiCalls(1);
    h.aiGates[0].resolve('first');
    const firstFinal = await h.finished(first);
    expect(h.stateOf(firstFinal, 'target').outputs).toEqual({ text: 'T:first' });

    const rerun = h.service.start({
      document,
      runtime: {},
      fromNodeId: 'target',
      previousOutputs: [previous('up', { text: 'client-supplied' })],
    });
    const final = await h.finished(rerun);
    expect(final.status).toBe('succeeded');
    expect(h.stateOf(final, 'target').outputs).toEqual({ text: 'T:client-supplied' });
    expect(h.stateOf(final, 'after').outputs).toEqual({ text: 'T:client-supplied' });
    expect(h.stateOf(final, 'up').outputs).toEqual({ text: 'client-supplied' });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('缺失、多余、范围内、类型错误、未知节点或端口及重复的边界输出被整体拒绝', async () => {
    const document = chainGraph();
    const invalid: [
      string,
      Partial<WorkflowExecutionInput>,
      { status: number; message: string },
    ][] = [
      ['只有 fromNodeId', { fromNodeId: 'target' }, WORKFLOW_EXECUTION_ERRORS.invalidRequest],
      [
        '只有 previousOutputs',
        { previousOutputs: [previous('up', { text: 'x' })] },
        WORKFLOW_EXECUTION_ERRORS.invalidRequest,
      ],
      [
        '缺少上游',
        { fromNodeId: 'target', previousOutputs: [] },
        WORKFLOW_EXECUTION_ERRORS.invalidDocument,
      ],
      [
        '多余的无关节点',
        {
          fromNodeId: 'target',
          previousOutputs: [previous('up', { text: 'x' }), previous('seed', { text: 'x' })],
        },
        WORKFLOW_EXECUTION_ERRORS.invalidDocument,
      ],
      [
        '范围内节点',
        {
          fromNodeId: 'target',
          previousOutputs: [previous('up', { text: 'x' }), previous('target', { text: 'x' })],
        },
        WORKFLOW_EXECUTION_ERRORS.invalidDocument,
      ],
      [
        '类型错误',
        { fromNodeId: 'target', previousOutputs: [previous('up', { text: 1 })] },
        WORKFLOW_EXECUTION_ERRORS.invalidDocument,
      ],
      [
        '未知端口',
        { fromNodeId: 'target', previousOutputs: [previous('up', { text: 'x', extra: 1 })] },
        WORKFLOW_EXECUTION_ERRORS.invalidDocument,
      ],
      [
        '未知节点',
        { fromNodeId: 'target', previousOutputs: [previous('ghost', { text: 'x' })] },
        WORKFLOW_EXECUTION_ERRORS.invalidDocument,
      ],
      [
        '重复节点',
        {
          fromNodeId: 'target',
          previousOutputs: [previous('up', { text: 'x' }), previous('up', { text: 'y' })],
        },
        WORKFLOW_EXECUTION_ERRORS.invalidDocument,
      ],
      [
        '未知起点',
        { fromNodeId: 'ghost', previousOutputs: [previous('up', { text: 'x' })] },
        WORKFLOW_EXECUTION_ERRORS.invalidDocument,
      ],
    ];
    for (const [label, extra, error] of invalid) {
      try {
        expectFailure(() => h.service.start({ document, runtime: {}, ...extra }), error);
      } catch (failure) {
        throw new Error(`${label}：${(failure as Error).message}`);
      }
    }
    expect(h.internals.records.size).toBe(0);
    expect(h.io.pendingRuns().size).toBe(0);
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe('飞书写入确认', () => {
  const expectedBody = {
    wikiUrl: WIKI_URL,
    range: 'C3:D3',
    values: [['a', 1]],
    confirmed: true,
    runtime: { appId: 'cli_app', appSecret: FEISHU_SECRET },
  };

  it('确认展示实际范围与矩阵，同意只一次性消费，重复确认无法再次写入', async () => {
    const run = h.start(writeGraph());
    const confirmation = await h.confirmationOf(run);
    expect(confirmation).toMatchObject({
      nodeId: 'write',
      nodeName: 'write',
      wikiUrl: WIKI_URL,
      range: 'C3:D3',
      values: [['a', 1]],
    });
    expect(h.writeCells).not.toHaveBeenCalled();
    expect(JSON.stringify(h.status(run))).not.toContain(FEISHU_SECRET);

    const answered = h.service.confirm(
      { runId: run.runId, confirmationId: confirmation.confirmationId, accepted: true },
      run.accessToken,
    );
    expect(answered.confirmations).toEqual([]);
    expectFailure(
      () =>
        h.service.confirm(
          { runId: run.runId, confirmationId: confirmation.confirmationId, accepted: true },
          run.accessToken,
        ),
      WORKFLOW_EXECUTION_ERRORS.invalidConfirmation,
    );
    await h.writeCalls(1);
    expect(h.writeCells.mock.calls[0][0]).toMatchObject(expectedBody);

    h.writeGates[0].resolve();
    const final = await h.finished(run);
    expect(final.status).toBe('succeeded');
    expect(h.stateOf(final, 'write').outputs).toEqual({
      result: { range: 'C3:D3', updatedCells: 2, status: 'written' },
    });
    expectFailure(
      () =>
        h.service.confirm(
          { runId: run.runId, confirmationId: confirmation.confirmationId, accepted: true },
          run.accessToken,
        ),
      WORKFLOW_EXECUTION_ERRORS.invalidConfirmation,
    );
    expect(h.writeCells).toHaveBeenCalledTimes(1);
  });

  it('拒绝确认不写入，写入节点失败并保持任务可查询', async () => {
    const run = h.start(writeGraph());
    const confirmation = await h.confirmationOf(run);
    h.service.confirm(
      { runId: run.runId, confirmationId: confirmation.confirmationId, accepted: false },
      run.accessToken,
    );
    const final = await h.finished(run);
    expect(final.status).toBe('failed');
    expect(h.stateOf(final, 'write')).toMatchObject({
      status: 'failed',
      message: '本次写入未确认，已取消写入。',
      outputs: null,
    });
    expect(h.writeCells).not.toHaveBeenCalled();
  });

  it('确认过期后无论按时钟还是定时器都不写入', async () => {
    const run = h.start(writeGraph());
    const confirmation = await h.confirmationOf(run);
    vi.setSystemTime(confirmation.expiresAt + 1); // 只越过期限，定时器尚未触发
    expectFailure(
      () =>
        h.service.confirm(
          { runId: run.runId, confirmationId: confirmation.confirmationId, accepted: true },
          run.accessToken,
        ),
      WORKFLOW_EXECUTION_ERRORS.invalidConfirmation,
    );
    const final = await h.finished(run);
    expect(h.stateOf(final, 'write').status).toBe('failed');
    expect(h.writeCells).not.toHaveBeenCalled();

    const timed = h.start(writeGraph());
    const pending = await h.confirmationOf(timed);
    await vi.advanceTimersByTimeAsync(pending.expiresAt - Date.now());
    const timedFinal = await h.finished(timed);
    expect(timedFinal.confirmations).toEqual([]);
    expect(h.stateOf(timedFinal, 'write')).toMatchObject({
      status: 'failed',
      message: '本次写入未确认，已取消写入。',
    });
    expect(h.writeCells).not.toHaveBeenCalled();
  });

  it('待确认时停止，或同意后同一 tick 停止，都不会发送写入', async () => {
    const pending = h.start(writeGraph());
    await h.confirmationOf(pending);
    const stopped = h.service.stop(pending.runId, pending.accessToken);
    expect(stopped).toMatchObject({ status: 'cancelled', confirmations: [] });
    expect(h.stateOf(stopped, 'write').message).toBe(WORKFLOW_EXECUTION_MESSAGES.stopped);

    const raced = h.start(writeGraph());
    const confirmation = await h.confirmationOf(raced);
    h.service.confirm(
      { runId: raced.runId, confirmationId: confirmation.confirmationId, accepted: true },
      raced.accessToken,
    );
    const final = h.service.stop(raced.runId, raced.accessToken); // 同一同步段内，写入决定尚未被执行器消费
    for (let index = 0; index < 5; index += 1) await tick();
    expect(final.status).toBe('cancelled');
    expect(h.stateOf(h.status(raced), 'write').message).toBe(WORKFLOW_EXECUTION_MESSAGES.stopped);
    expect(h.writeCells).not.toHaveBeenCalled();
  });

  it('写请求发出后停止会标记远端可能已经写入，迟到结果不改写终态', async () => {
    const run = h.start(writeGraph());
    const confirmation = await h.confirmationOf(run);
    h.service.confirm(
      { runId: run.runId, confirmationId: confirmation.confirmationId, accepted: true },
      run.accessToken,
    );
    await h.writeCalls(1);

    const stopped = h.service.stop(run.runId, run.accessToken);
    expect(stopped.status).toBe('cancelled');
    expect(h.stateOf(stopped, 'write')).toMatchObject({
      status: 'cancelled',
      message: WORKFLOW_EXECUTION_MESSAGES.uncertainWrite,
      outputs: null,
    });
    expect(h.stateOf(stopped, 'write').message).toContain('可能已经写入');

    h.writeGates[0].resolve();
    for (let index = 0; index < 5; index += 1) await tick();
    expect(h.stateOf(h.status(run), 'write')).toMatchObject({ status: 'cancelled', outputs: null });
    expect(h.writeCells).toHaveBeenCalledTimes(1);
  });
});

describe('TTL 与清理', () => {
  it('活动期限为绝对期限，status/subscribe 不续期，到期后取消并保留结果期限', async () => {
    const run = h.start(aiGraph());
    await h.aiCalls(1);
    expect(run.expiresAt).toBe(T0 + activeTtlMs);

    await vi.advanceTimersByTimeAsync(activeTtlMs - 60_000);
    for (let index = 0; index < 3; index += 1) {
      expect(h.status(run)).toMatchObject({ running: true, expiresAt: run.expiresAt });
      h.service.subscribe(run.runId, run.accessToken, () => undefined)();
    }
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.status(run)).toMatchObject({ running: true, expiresAt: run.expiresAt });

    await vi.advanceTimersByTimeAsync(1);
    const expired = h.status(run);
    expect(expired).toMatchObject({
      running: false,
      status: 'cancelled',
      expiresAt: T0 + activeTtlMs + resultTtlMs,
    });
    expect(h.stateOf(expired, 'ai').message).toBe(WORKFLOW_EXECUTION_MESSAGES.expired);

    await vi.advanceTimersByTimeAsync(resultTtlMs - 1);
    expect(h.status(run).expiresAt).toBe(T0 + activeTtlMs + resultTtlMs); // 读取不续期
    await vi.advanceTimersByTimeAsync(1);
    expectFailure(() => h.status(run), WORKFLOW_EXECUTION_ERRORS.notFound);
    expect(h.internals.residualReservations.size).toBe(1); // 底层调用未结清，额度继续记账

    h.aiGates[0].resolve('late');
    await until(() => h.io.pendingRuns().size === 0, '过期任务的调用结清');
    h.start(localGraph()); // 创建任务时清理残留额度
    expect(h.internals.residualReservations.size).toBe(0);
  });

  it('确认期限固定且小于活动期限，临近任务期限时不超过任务期限', async () => {
    expect(confirmationTtlMs).toBeLessThan(activeTtlMs);
    const early = h.start(writeGraph());
    const earlyConfirmation = await h.confirmationOf(early);
    expect(earlyConfirmation.expiresAt).toBe(T0 + confirmationTtlMs);

    const late = h.start(lateWriteGraph());
    await h.aiCalls(1);
    await vi.advanceTimersByTimeAsync(activeTtlMs - 5 * 60_000);
    h.aiGates[0].resolve('[["x"]]');
    const lateConfirmation = await h.confirmationOf(late);
    expect(Date.now() + confirmationTtlMs).toBeGreaterThan(late.expiresAt);
    expect(lateConfirmation.expiresAt).toBe(late.expiresAt);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const final = h.status(late);
    expect(final).toMatchObject({ running: false, confirmations: [] });
    expect(h.stateOf(final, 'write')).toMatchObject({
      status: 'cancelled',
      message: WORKFLOW_EXECUTION_MESSAGES.expired,
      outputs: null,
    });
    expectFailure(
      () =>
        h.service.confirm(
          { runId: late.runId, confirmationId: lateConfirmation.confirmationId, accepted: true },
          late.accessToken,
        ),
      WORKFLOW_EXECUTION_ERRORS.invalidConfirmation,
    );
    expect(h.writeCells).not.toHaveBeenCalled();
  });

  it('结果期限从结束时起算且读取不续期，到期后所有入口一致返回 404', async () => {
    const run = h.start(localGraph());
    const final = await h.finished(run);
    expect(final.expiresAt).toBe(T0 + resultTtlMs);

    await vi.advanceTimersByTimeAsync(resultTtlMs - 1);
    expect(h.status(run).expiresAt).toBe(T0 + resultTtlMs);
    h.service.subscribe(run.runId, run.accessToken, () => undefined)();
    expect(h.status(run).expiresAt).toBe(T0 + resultTtlMs);

    await vi.advanceTimersByTimeAsync(1);
    expectFailure(() => h.status(run), WORKFLOW_EXECUTION_ERRORS.notFound);
    expectFailure(() => h.status(run, 'jc'), WORKFLOW_EXECUTION_ERRORS.notFound);
    expectFailure(
      () => h.service.stop(run.runId, run.accessToken),
      WORKFLOW_EXECUTION_ERRORS.notFound,
    );
    expectFailure(
      () => h.service.subscribe(run.runId, run.accessToken, () => undefined),
      WORKFLOW_EXECUTION_ERRORS.notFound,
    );
    expectFailure(
      () =>
        h.service.confirm(
          { runId: run.runId, confirmationId: 'gone', accepted: true },
          run.accessToken,
        ),
      WORKFLOW_EXECUTION_ERRORS.notFound,
    );
  });

  it('onModuleDestroy 取消全部任务、通知订阅者并清除所有定时器，之后拒绝新任务', async () => {
    const active = h.start(aiGraph());
    const waiting = h.start(writeGraph());
    await h.aiCalls(1);
    await h.confirmationOf(waiting);
    const events: ExecutionEvent[] = [];
    h.service.subscribe(active.runId, active.accessToken, (event) => events.push(event));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    h.service.onModuleDestroy();

    expect(events.at(-1)).toMatchObject({ type: 'run-finished', data: { status: 'cancelled' } });
    expect(h.generate.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(h.internals.subscribers).toBe(0);
    expect(h.internals.records.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expectFailure(() => h.start(localGraph()), WORKFLOW_EXECUTION_ERRORS.unavailable);
    expectFailure(() => h.status(active), WORKFLOW_EXECUTION_ERRORS.notFound);
    expect(h.writeCells).not.toHaveBeenCalled();
  });
});
