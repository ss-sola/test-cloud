import axios, { type AxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiTextClientException } from '../client/ai/ai-text-client.exception';
import { AiTextClientService } from '../client/ai/ai-text-client.service';
import type { AiTextRequest } from '../client/ai/ai-text-client.service';
import {
  AI_TEXT_BATCH_PROMPTS,
  AI_TEXT_BATCHING,
} from '../constants/workflow-capability.constants';
import { AiTextBatchUtil } from '../modules/workflow-capabilities/ai-text-batch.util';
import { AiTextCapabilityService } from '../modules/workflow-capabilities/ai-text-capability.service';
import type { AiTextDto } from '../modules/workflow-capabilities/dto/ai-text.dto';
import { WorkflowCapabilityException } from '../modules/workflow-capabilities/workflow-capability.exception';

const SMALL = 4096;
const SYSTEM = 'ORIGINAL_SYSTEM_RULES';
const bytes = (text: string) => Buffer.byteLength(text);
const joinSystem = (...parts: Array<string | undefined>) => parts.filter(Boolean).join('\n\n');
const budgetOf = (context: number) =>
  Math.floor(context * AI_TEXT_BATCHING.inputRatio) - AI_TEXT_BATCHING.messageOverheadTokens;

function dto(prompt: string, overrides: Partial<AiTextDto> = {}): AiTextDto {
  return {
    prompt,
    contextWindowTokens: SMALL,
    runtime: {
      ai: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-batching-test', model: 'm' },
    },
    ...overrides,
  };
}

/** 每行恰好 width 字节的 ASCII 文本，便于精确构造批次数。 */
const lines = (count: number, width = 100) =>
  Array.from(
    { length: count },
    (_, i) => `L${String(i).padStart(4, '0')} `.padEnd(width - 1, 'x') + '\n',
  ).join('');

function mapCapacity(context: number, systemPrompt?: string): number {
  const mapSystem = joinSystem(systemPrompt, AI_TEXT_BATCH_PROMPTS.mapSystem);
  const label = `分片 ${AI_TEXT_BATCHING.maxBatches}/${AI_TEXT_BATCHING.maxBatches}\n`;
  return budgetOf(context) - bytes(mapSystem) - bytes(label + AI_TEXT_BATCH_PROMPTS.mapPrefix);
}

function reduceWindow(context: number, instructions: string[], systemPrompt?: string): number {
  const prefix = `${AI_TEXT_BATCH_PROMPTS.instructionPrefix}${JSON.stringify(instructions)}${AI_TEXT_BATCH_PROMPTS.materialPrefix}`;
  return (
    budgetOf(context) -
    bytes(joinSystem(systemPrompt, AI_TEXT_BATCH_PROMPTS.reduceSystem)) -
    bytes(prefix)
  );
}

/** 构造恰好需要 batches 个分片的长输入。 */
function longPrompt(batches: number, systemPrompt?: string): string {
  const perBatch = Math.floor(mapCapacity(SMALL, systemPrompt) / 100);
  // 两批时总量仍需超过单次预算，否则会走原样单次调用
  const overBudget = Math.ceil((budgetOf(SMALL) - bytes(systemPrompt ?? '')) / 100) + 1;
  const prompt = lines(Math.max(perBatch * (batches - 1) + 1, overBudget));
  expect(AiTextBatchUtil.initialPlan(dto(prompt, { systemPrompt })).batches).toHaveLength(batches);
  return prompt;
}

/** 构造归并窗口中占用约 size 字节的材料（含 `材料 N\n` 标签），以标记开头。 */
function material(index: number, size: number): string {
  const marker = `M${index}`;
  return (
    marker +
    'x'.repeat(Math.max(0, Math.floor(size) - bytes(`材料 ${index + 1}\n`) - marker.length))
  );
}

const mapReply = (instructions: string, content: string) =>
  JSON.stringify({ instructions, content });
const stageOf = (request: AiTextRequest) =>
  request.systemPrompt?.includes(AI_TEXT_BATCH_PROMPTS.mapSystem)
    ? 'map'
    : request.systemPrompt?.includes(AI_TEXT_BATCH_PROMPTS.reduceSystem)
      ? 'reduce'
      : 'final';

/** 工作流编排始终显式传入取消信号；客户端类型中的 signal 为可选。 */
type SignalledRequest = AiTextRequest & { signal: AbortSignal };

interface PendingCall {
  request: SignalledRequest;
  index: number;
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
}
type Handler = (request: SignalledRequest, index: number) => string | Promise<string> | undefined;

/** 可控制完成时机的模型客户端；未提供 handler 或 handler 返回 undefined 时，调用保持挂起直到手动完成。 */
class FakeAiClient {
  readonly calls: PendingCall[] = [];
  inflight = 0;
  maxInflight = 0;

  constructor(private readonly options: { honorSignal?: boolean; handler?: Handler } = {}) {}

  generate(request: AiTextRequest): Promise<string> {
    const call = { request: request as SignalledRequest, index: this.calls.length } as PendingCall;
    const promise = new Promise<string>((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
    });
    this.calls.push(call);
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    if (this.options.honorSignal ?? true) {
      const signal = request.signal!;
      signal.addEventListener('abort', () => call.reject(signal.reason), { once: true });
    }
    const automatic = this.options.handler?.(call.request, call.index);
    if (automatic !== undefined) Promise.resolve(automatic).then(call.resolve, call.reject);
    return promise.finally(() => {
      this.inflight -= 1;
    });
  }

  service() {
    return new AiTextCapabilityService(this as unknown as AiTextClientService);
  }
}

function track<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
  const done = promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return { state, done };
}

const idle = () => new Promise<void>((done) => setTimeout(done, 20));
const waitForCalls = (client: FakeAiClient, count: number) =>
  vi.waitFor(() => expect(client.calls.length).toBe(count));

async function failure(promise: Promise<unknown>): Promise<WorkflowCapabilityException> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WorkflowCapabilityException);
  return error as WorkflowCapabilityException;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AiTextBatchUtil.initialPlan', () => {
  it('keeps the original request in one call up to the UTF-8 byte budget (20% reserve + 256 overhead)', () => {
    expect(budgetOf(SMALL)).toBe(3020);
    expect(budgetOf(100_000)).toBe(79_744);
    const rows: Array<{ context?: number; system?: string; direct: string; over: string }> = [
      { context: undefined, direct: 'a'.repeat(79_744), over: 'a'.repeat(79_745) },
      { context: SMALL, direct: 'a'.repeat(3020), over: 'a'.repeat(3021) },
      { context: SMALL, direct: '字'.repeat(1006), over: '字'.repeat(1007) },
      { context: SMALL, system: 's'.repeat(20), direct: 'a'.repeat(3000), over: 'a'.repeat(3001) },
    ];
    for (const row of rows) {
      const options = { contextWindowTokens: row.context, systemPrompt: row.system };
      const direct = AiTextBatchUtil.initialPlan(dto(row.direct, options));
      expect(direct.stage).toBe('direct');
      expect(direct.systemPrompt).toBe(row.system);
      expect(direct.batches).toEqual([{ prompt: row.direct, sourceIndexes: [0] }]);

      const over = AiTextBatchUtil.initialPlan(dto(row.over, options));
      expect(over.stage).toBe('map');
      expect(over.batches.length).toBeGreaterThan(1);
    }
  });

  it('splits CJK, emoji and CRLF text without losing or corrupting any character and within the budget', () => {
    const block = 'English line\r\n中文内容，混合 emoji 😀🚀\n  \t缩进行\n';
    const prompt = `  ${block.repeat(120)}${'😀'.repeat(1500)}\n尾部 `;
    const plan = AiTextBatchUtil.initialPlan(dto(prompt, { systemPrompt: SYSTEM }));
    expect(plan.stage).toBe('map');
    expect(plan.systemPrompt).toBe(joinSystem(SYSTEM, AI_TEXT_BATCH_PROMPTS.mapSystem));
    const pieces = plan.batches.map((batch, index) => {
      expect(batch.sourceIndexes).toEqual([index]);
      expect(batch.prompt.startsWith(`分片 ${index + 1}/${plan.batches.length}\n`)).toBe(true);
      expect(bytes(plan.systemPrompt!) + bytes(batch.prompt)).toBeLessThanOrEqual(budgetOf(SMALL));
      return batch.prompt.slice(
        batch.prompt.indexOf(AI_TEXT_BATCH_PROMPTS.mapPrefix) +
          AI_TEXT_BATCH_PROMPTS.mapPrefix.length,
      );
    });
    expect(plan.batches.length).toBeGreaterThan(2);
    expect(pieces.join('')).toBe(prompt);
    for (const piece of pieces) expect(Buffer.from(piece, 'utf8').toString('utf8')).toBe(piece);
  });

  it('prefers newline boundaries when splitting line-oriented input', () => {
    const plan = AiTextBatchUtil.initialPlan(dto(lines(100)));
    expect(plan.batches.length).toBeGreaterThan(2);
    const pieces = plan.batches.map((batch) =>
      batch.prompt.slice(
        batch.prompt.indexOf(AI_TEXT_BATCH_PROMPTS.mapPrefix) +
          AI_TEXT_BATCH_PROMPTS.mapPrefix.length,
      ),
    );
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.endsWith('\n')).toBe(true);
      expect(piece.length % 100).toBe(0);
    }
  });

  it('allows exactly 64 batches and rejects the 65th need', () => {
    const capacity = mapCapacity(SMALL);
    const exact = AiTextBatchUtil.initialPlan(dto('a'.repeat(64 * capacity)));
    expect(exact.batches).toHaveLength(AI_TEXT_BATCHING.maxBatches);
    expect(() => AiTextBatchUtil.initialPlan(dto('a'.repeat(64 * capacity + 1)))).toThrowError(
      expect.objectContaining({ status: 422 }),
    );
  });
});

describe('AiTextBatchUtil.mergePlan', () => {
  const window = reduceWindow(SMALL, ['TASK'], SYSTEM);
  /** mergePlan 会为每条材料加上 `材料 N\n` 标签，material 已按含标签的占用大小生成正文。 */
  const body = (index: number, size: number) => material(index, size);

  it('merges everything in source order in one final call when instructions and materials fit', () => {
    const result = AiTextBatchUtil.mergePlan({
      materials: ['first-material', 'second-material', 'third-material'],
      instructions: ['TASK_A', 'TASK_B'],
      systemPrompt: SYSTEM,
      contextWindowTokens: SMALL,
    });
    expect(result.stage).toBe('final');
    expect(result.systemPrompt).toBe(joinSystem(SYSTEM, AI_TEXT_BATCH_PROMPTS.finalSystem));
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].sourceIndexes).toEqual([0, 1, 2]);
    const prompt = result.batches[0].prompt;
    expect(
      prompt.startsWith(
        `${AI_TEXT_BATCH_PROMPTS.instructionPrefix}${JSON.stringify(['TASK_A', 'TASK_B'])}`,
      ),
    ).toBe(true);
    const positions = ['first-material', 'second-material', 'third-material'].map((item) =>
      prompt.indexOf(item),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((position) => position > 0)).toBe(true);
  });

  it('groups greedily in order and keeps single-item groups (tail or middle) as carry-overs', () => {
    const tail = AiTextBatchUtil.mergePlan({
      materials: [0, 1, 2, 3, 4].map((i) => body(i, window / 2 - 2)),
      instructions: ['TASK'],
      systemPrompt: SYSTEM,
      contextWindowTokens: SMALL,
    });
    expect(tail.stage).toBe('reduce');
    expect(tail.systemPrompt).toBe(joinSystem(SYSTEM, AI_TEXT_BATCH_PROMPTS.reduceSystem));
    expect(tail.batches.map((batch) => batch.sourceIndexes)).toEqual([[0, 1], [2, 3], [4]]);

    const middle = AiTextBatchUtil.mergePlan({
      materials: [0.4, 0.9, 0.4, 0.4, 0.4].map((fraction, i) => body(i, fraction * window)),
      instructions: ['TASK'],
      systemPrompt: SYSTEM,
      contextWindowTokens: SMALL,
    });
    expect(middle.batches.map((batch) => batch.sourceIndexes)).toEqual([[0], [1], [2, 3], [4]]);
    expect(middle.batches[2].prompt.indexOf('M2')).toBeLessThan(
      middle.batches[2].prompt.indexOf('M3'),
    );
  });

  it.each([
    [
      'a single material larger than the merge window',
      () => ['small', 'x'.repeat(window + 1)],
      ['TASK'],
    ],
    [
      'shared instructions that alone exceed the budget',
      () => ['a', 'b'],
      ['I'.repeat(budgetOf(SMALL))],
    ],
    [
      'materials that cannot be combined so the count would not shrink',
      () => [0, 1, 2].map((i) => body(i, 0.6 * window)),
      ['TASK'],
    ],
  ])('rejects with 422 for %s', (_name, materials, instructions) => {
    expect(() =>
      AiTextBatchUtil.mergePlan({
        materials: materials(),
        instructions,
        systemPrompt: SYSTEM,
        contextWindowTokens: SMALL,
      }),
    ).toThrowError(expect.objectContaining({ status: 422 }));
  });
});

describe('AiTextCapabilityService batching', () => {
  it('sends a small input once with the original prompt and returns the model text verbatim at the default 100k window', async () => {
    const prompt = 'x'.repeat(79_744 - bytes(SYSTEM));
    const client = new FakeAiClient({ handler: () => '  raw model text \n' });
    const controller = new AbortController();

    const result = await client
      .service()
      .generate(
        dto(prompt, { contextWindowTokens: undefined, systemPrompt: SYSTEM }),
        controller.signal,
      );

    expect(result).toEqual({ text: '  raw model text \n' });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].request).toMatchObject({
      prompt,
      systemPrompt: SYSTEM,
      signal: controller.signal,
    });
  });

  it('runs at least two batches concurrently but never more than three, and merges in source order despite out-of-order completion', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const client = new FakeAiClient();
    const parent = new AbortController();
    const run = track(client.service().generate(dto(longPrompt(5)), parent.signal));

    await waitForCalls(client, 3);
    await idle();
    expect(client.calls).toHaveLength(3);
    expect(client.inflight).toBe(3);
    client.calls.forEach((call, index) =>
      expect(call.request.prompt.startsWith(`分片 ${index + 1}/5\n`)).toBe(true),
    );

    client.calls[2].resolve(mapReply('', 'M2'));
    await waitForCalls(client, 4);
    client.calls[0].resolve(mapReply('', 'M0'));
    await waitForCalls(client, 5);
    client.calls[4].resolve(mapReply('', 'M4'));
    client.calls[3].resolve(mapReply('', 'M3'));
    client.calls[1].resolve(mapReply('', 'M1'));
    await waitForCalls(client, 6);

    const merge = client.calls[5].request;
    expect(stageOf(merge)).toBe('final');
    const positions = ['M0', 'M1', 'M2', 'M3', 'M4'].map((marker) => merge.prompt.indexOf(marker));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    client.calls[5].resolve('FINAL');
    await run.done;

    expect(run.state.value).toEqual({ text: 'FINAL' });
    expect(client.maxInflight).toBe(3);
    expect(timeout).not.toHaveBeenCalled();
  });

  it('shares head, tail and cross-fragment task requirements with the merge call and repeats the original system prompt at every stage', async () => {
    const instructions = [
      'HEAD_TASK: 输出 JSON 数组',
      '   ',
      'FORMAT_PART_A: 每项含 id',
      'FORMAT_PART_B: 按 id 升序',
      'TAIL_TASK: 末尾带 total',
      'HEAD_TASK: 输出 JSON 数组',
    ];
    const client = new FakeAiClient({
      handler: (request, index) =>
        stageOf(request) === 'map'
          ? mapReply(instructions[index], `C${index}`)
          : '  not json at all\n',
    });

    const result = await client
      .service()
      .generate(dto(longPrompt(6, SYSTEM), { systemPrompt: SYSTEM }), new AbortController().signal);

    expect(client.calls).toHaveLength(7);
    expect(client.calls.every((call) => call.request.systemPrompt?.startsWith(SYSTEM))).toBe(true);
    const merge = client.calls[6].request;
    expect(stageOf(merge)).toBe('final');
    const shared = [
      'HEAD_TASK: 输出 JSON 数组',
      'FORMAT_PART_A: 每项含 id',
      'FORMAT_PART_B: 按 id 升序',
      'TAIL_TASK: 末尾带 total',
    ];
    expect(
      merge.prompt.startsWith(
        `${AI_TEXT_BATCH_PROMPTS.instructionPrefix}${JSON.stringify(shared)}${AI_TEXT_BATCH_PROMPTS.materialPrefix}`,
      ),
    ).toBe(true);
    expect(merge.prompt).toContain('C0');
    expect(merge.prompt.indexOf('C0')).toBeLessThan(merge.prompt.indexOf('C5'));
    expect(client.calls.every((call) => !call.request.systemPrompt?.includes('HEAD_TASK'))).toBe(
      true,
    );
    expect(result.text).toBe('  not json at all\n');
  });

  it.each([false, true])(
    'preserves enableThinking=%s through hierarchical merges and uses only the last round for the final answer',
    async (enableThinking) => {
      const window = reduceWindow(SMALL, ['TASK'], SYSTEM);
      const fractions = [0.4, 0.9, 0.4, 0.4];
      const reduceReplies = ['R_A', 'R_B'];
      let reduceCount = 0;
      const client = new FakeAiClient({
        handler: (request, index) => {
          const stage = stageOf(request);
          if (stage === 'map')
            return mapReply(index === 0 ? 'TASK' : '', material(index, fractions[index] * window));
          return stage === 'reduce' ? reduceReplies[reduceCount++] : 'FINAL_TEXT';
        },
      });

      const result = await client.service().generate(
        dto(longPrompt(4, SYSTEM), {
          systemPrompt: SYSTEM,
          runtime: { ai: { ...dto('').runtime.ai, enableThinking } },
        }),
        new AbortController().signal,
      );

      expect(result).toEqual({ text: 'FINAL_TEXT' });
      expect(client.calls.every((call) => call.request.enableThinking === enableThinking)).toBe(
        true,
      );
      expect(client.calls.map((call) => stageOf(call.request))).toEqual([
        'map',
        'map',
        'map',
        'map',
        'reduce',
        'reduce',
        'final',
      ]);
      const [reduce1, reduce2, final] = client.calls.slice(4).map((call) => call.request);
      expect(reduce1.prompt).toContain('M2');
      expect(reduce1.prompt).toContain('M3');
      expect(reduce1.prompt).not.toMatch(/M0|M1/);
      expect(reduce2.prompt).toContain('M1');
      expect(reduce2.prompt.indexOf('M1')).toBeLessThan(reduce2.prompt.indexOf('R_A'));
      expect(reduce2.prompt).not.toContain('M0');
      expect(final.prompt.indexOf('M0')).toBeLessThan(final.prompt.indexOf('R_B'));
      expect(final.prompt).not.toMatch(/M1|M2|M3|R_A/);
      // M0 作为单项材料一直原样携带，从未单独外呼
      expect(
        client.calls.filter(
          (call) => call.request.prompt.includes('M0') && stageOf(call.request) !== 'final',
        ),
      ).toHaveLength(0);
      expect(client.calls.every((call) => call.request.systemPrompt?.startsWith(SYSTEM))).toBe(
        true,
      );
    },
  );

  it('fails with 422 once four merge rounds cannot finish, without ever issuing a final call', async () => {
    const size = Math.floor(0.45 * reduceWindow(SMALL, []));
    const client = new FakeAiClient({
      handler: (request, index) =>
        stageOf(request) === 'map' ? mapReply('', material(index, size)) : 'y'.repeat(size - 10),
    });

    const error = await failure(
      client.service().generate(dto(longPrompt(17)), new AbortController().signal),
    );

    expect(error.getStatus()).toBe(422);
    expect(error.message).toContain('轮数');
    // 17 次分片 + 8 + 4 + 2 + 1 次归并
    expect(client.calls).toHaveLength(32);
    expect(client.calls.some((call) => stageOf(call.request) === 'final')).toBe(false);
  });

  it('stops before exceeding the total call budget', async () => {
    vi.resetModules();
    vi.doMock('../constants/workflow-capability.constants', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../constants/workflow-capability.constants')>();
      return {
        ...actual,
        AI_TEXT_BATCHING: Object.freeze({ ...actual.AI_TEXT_BATCHING, maxCalls: 5 }),
      };
    });
    try {
      const { AiTextCapabilityService: LimitedService } =
        await import('../modules/workflow-capabilities/ai-text-capability.service');
      const size = 0.45 * reduceWindow(SMALL, []);
      const client = new FakeAiClient({
        handler: (_request, index) => mapReply('', material(index, size)),
      });

      const error = await LimitedService.prototype.generate
        .call(
          new LimitedService(client as unknown as AiTextClientService),
          dto(longPrompt(4)),
          new AbortController().signal,
        )
        .then(
          () => undefined,
          (reason: unknown) => reason as WorkflowCapabilityException,
        );

      // 4 次分片 + 2 次归并将超过 5 次预算，归并外呼前即拒绝
      expect(error?.getStatus()).toBe(422);
      expect(client.calls).toHaveLength(4);
    } finally {
      vi.doUnmock('../constants/workflow-capability.constants');
      vi.resetModules();
    }
  });

  it('rejects when cumulative intermediate results exceed the character budget, without merging', async () => {
    const client = new FakeAiClient({ handler: () => mapReply('', 'z'.repeat(200_000)) });

    const error = await failure(
      client.service().generate(dto(longPrompt(3)), new AbortController().signal),
    );

    expect(error.getStatus()).toBe(422);
    expect(error.message).toContain('总长度');
    expect(client.calls).toHaveLength(3);
  });

  it('rejects non-converging materials with 422 and issues no merge call', async () => {
    const window = reduceWindow(SMALL, []);
    const client = new FakeAiClient({
      handler: (_request, index) => mapReply('', material(index, 0.6 * window)),
    });

    const error = await failure(
      client.service().generate(dto(longPrompt(3)), new AbortController().signal),
    );

    expect(error.getStatus()).toBe(422);
    expect(client.calls).toHaveLength(3);
  });

  it.each([
    ['not JSON', 'LEAK-not-json'],
    ['empty text', ''],
    ['array', '[]'],
    ['null', 'null'],
    ['string', '"LEAK"'],
    ['missing content', '{"instructions":"a"}'],
    ['non-string content', '{"instructions":"a","content":1}'],
    ['non-string instructions', '{"instructions":1,"content":"b"}'],
    ['extra field', '{"instructions":"a","content":"b","extra":"LEAK"}'],
    ['blank instructions and content', '{"instructions":"","content":"  "}'],
  ])(
    'fails the whole node with 502 when a map batch returns %s, without merging or echoing the output',
    async (_name, output) => {
      const client = new FakeAiClient({
        handler: (_request, index) => (index === 1 ? output : mapReply('', 'ok')),
      });

      const error = await failure(
        client.service().generate(dto(longPrompt(2)), new AbortController().signal),
      );

      expect(error.getStatus()).toBe(502);
      expect(error.message).not.toContain('LEAK');
      expect(client.calls).toHaveLength(2);
    },
  );

  it('rejects as soon as one map batch returns bad JSON, even if siblings never settle or ignore the signal, and claims no queued batch', async () => {
    const client = new FakeAiClient({ honorSignal: false });
    const run = track(client.service().generate(dto(longPrompt(6)), new AbortController().signal));

    await waitForCalls(client, 3);
    client.calls[1].resolve('LEAK-not-json');
    await run.done;

    expect(run.state.error).toBeInstanceOf(WorkflowCapabilityException);
    expect((run.state.error as WorkflowCapabilityException).getStatus()).toBe(502);
    expect(client.calls[0].request.signal.aborted).toBe(true);
    expect(client.inflight).toBe(2);
    client.calls[0].resolve(mapReply('', 'late0'));
    client.calls[2].resolve(mapReply('', 'late2'));
    await idle();
    expect(client.calls).toHaveLength(3);
  });

  it('rejects before any external call when the system prompt exhausts the budget or more than 64 batches are needed', async () => {
    const cases = [
      dto('hello', { systemPrompt: 's'.repeat(20_000) }),
      dto(lines(Math.floor(mapCapacity(SMALL) / 100) * 64 + 1)),
    ];
    for (const input of cases) {
      const client = new FakeAiClient();
      const error = await failure(client.service().generate(input, new AbortController().signal));
      expect(error.getStatus()).toBe(422);
      expect(client.calls).toHaveLength(0);
    }
  });

  it('cancels siblings, stops queued batches and never merges when one map batch fails', async () => {
    const client = new FakeAiClient({ honorSignal: false });
    const upstream = new WorkflowCapabilityException('上游失败', 502);
    const run = track(client.service().generate(dto(longPrompt(6)), new AbortController().signal));

    await waitForCalls(client, 3);
    client.calls[1].reject(upstream);
    await run.done;

    expect(run.state.error).toBe(upstream);
    expect(client.calls.every((call) => call.request.signal.aborted)).toBe(true);
    client.calls[0].resolve(mapReply('', 'late0'));
    client.calls[2].resolve(mapReply('', 'late2'));
    await idle();
    expect(client.calls).toHaveLength(3);
    expect(run.state.value).toBeUndefined();
  });

  it('cancels the sibling reduce call and skips the final call when a reduce call fails', async () => {
    const size = 0.45 * reduceWindow(SMALL, []);
    const client = new FakeAiClient({
      handler: (request, index) =>
        stageOf(request) === 'map' ? mapReply('', material(index, size)) : undefined,
    });
    const upstream = new WorkflowCapabilityException('归并失败', 502);
    const run = track(client.service().generate(dto(longPrompt(4)), new AbortController().signal));

    await waitForCalls(client, 6);
    client.calls[4].reject(upstream);
    await run.done;

    expect(run.state.error).toBe(upstream);
    expect(client.calls[5].request.signal.aborted).toBe(true);
    await idle();
    expect(client.calls).toHaveLength(6);
  });

  it.each([
    ['small input', 'short prompt'],
    ['long input', longPrompt(3)],
  ])('rejects a pre-aborted %s without any external call', async (_name, prompt) => {
    const client = new FakeAiClient();
    const controller = new AbortController();
    const reason = new Error('stopped-before-start');
    controller.abort(reason);

    await expect(client.service().generate(dto(prompt), controller.signal)).rejects.toBe(reason);
    expect(client.calls).toHaveLength(0);
  });

  it('rejects immediately on caller cancellation even if the client ignores the signal, and ignores late results', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const client = new FakeAiClient({ honorSignal: false });
    const parent = new AbortController();
    const reason = new Error('user-stop');
    const run = track(client.service().generate(dto(longPrompt(4)), parent.signal));

    await waitForCalls(client, 3);
    parent.abort(reason);
    await run.done;

    expect(run.state.error).toBe(reason);
    expect(client.calls.every((call) => call.request.signal.aborted)).toBe(true);
    for (const call of client.calls) call.resolve(mapReply('', 'late'));
    await idle();
    expect(client.calls).toHaveLength(3);
    expect(run.state.value).toBeUndefined();
    expect(run.state.error).toBe(reason);
    expect(timeout).not.toHaveBeenCalled();
  });

  it('rejects immediately when cancelled during the final merge call and drops its late answer', async () => {
    const client = new FakeAiClient({
      honorSignal: false,
      handler: (request) => (stageOf(request) === 'map' ? mapReply('', 'tiny') : undefined),
    });
    const parent = new AbortController();
    const reason = new Error('stop-final');
    const run = track(client.service().generate(dto(longPrompt(2)), parent.signal));

    await waitForCalls(client, 3);
    expect(stageOf(client.calls[2].request)).toBe('final');
    parent.abort(reason);
    await run.done;

    expect(run.state.error).toBe(reason);
    client.calls[2].resolve('LATE_FINAL');
    await idle();
    expect(run.state.value).toBeUndefined();
    expect(client.calls).toHaveLength(3);
  });
});

describe('AiTextCapabilityService batching with the real AiTextClientService', () => {
  interface StubResponse {
    status: number;
    headers: Record<string, string>;
    data: string;
  }

  function completion(content: string, finishReason: unknown = 'stop'): StubResponse {
    return {
      status: 200,
      headers: {},
      data: JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }),
    };
  }

  /** 桩住 axios.request，使调用经过真实的 LangChain invoke 与模型适配器。 */
  function setup(respond: (system: string, user: string, index: number) => StubResponse) {
    const request = vi.spyOn(axios, 'request').mockImplementation((async (
      config: AxiosRequestConfig,
    ) => {
      const { messages } = config.data as { messages: Array<{ role: string; content: string }> };
      const response = respond(
        messages[0].content,
        messages[1].content,
        request.mock.calls.length - 1,
      );
      return { statusText: '', config, ...response };
    }) as unknown as typeof axios.request);
    const service = new AiTextCapabilityService(new AiTextClientService());
    return { request, service };
  }

  const configs = (request: { mock: { calls: unknown[][] } }) =>
    request.mock.calls.map(([config]) => config as AxiosRequestConfig);

  async function clientFailure(promise: Promise<unknown>): Promise<AiTextClientException> {
    const error = await promise.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AiTextClientException);
    return error as AiTextClientException;
  }

  it('maps, merges and returns the final stop-completed text through the real client without output-token caps', async () => {
    const prompt = longPrompt(4, SYSTEM);
    const { request, service } = setup((system, user) =>
      system.includes(AI_TEXT_BATCH_PROMPTS.mapSystem)
        ? completion(
            mapReply(
              user.startsWith('分片 1/4') ? 'TASK_E2E' : '',
              `摘要 ${user.slice(0, user.indexOf('\n'))}`,
            ),
          )
        : completion('FINAL_E2E_TEXT'),
    );

    const result = await service.generate(
      dto(prompt, { systemPrompt: SYSTEM, maxTokens: 123 }),
      new AbortController().signal,
    );

    expect(result).toEqual({ text: 'FINAL_E2E_TEXT' });
    expect(request).toHaveBeenCalledTimes(5);
    const sent = configs(request);
    const bodies = sent.map(
      (config) =>
        config.data as {
          model: string;
          stream: boolean;
          messages: Array<{ role: string; content: string }>;
        },
    );
    for (const [index, body] of bodies.entries()) {
      expect(body).toMatchObject({ model: 'm', stream: false, enable_thinking: false });
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body.messages[0].content.startsWith(SYSTEM)).toBe(true);
      expect(body.messages[1].role).toBe('user');
      expect(sent[index]).toMatchObject({
        url: 'https://api.example.com/v1/chat/completions',
        timeout: 0,
        adapter: 'http',
      });
    }
    expect(
      sent.every((config) => config.headers?.Authorization === 'Bearer sk-batching-test'),
    ).toBe(true);
    const pieces = bodies.slice(0, 4).map((body) => {
      const user = body.messages[1].content;
      return user.slice(
        user.indexOf(AI_TEXT_BATCH_PROMPTS.mapPrefix) + AI_TEXT_BATCH_PROMPTS.mapPrefix.length,
      );
    });
    expect(pieces.join('')).toBe(prompt);
    expect(
      bodies[4].messages[1].content.startsWith(
        `${AI_TEXT_BATCH_PROMPTS.instructionPrefix}${JSON.stringify(['TASK_E2E'])}`,
      ),
    ).toBe(true);
  });

  it('propagates an upstream-truncated map batch as 422 and never sends a merge request', async () => {
    const { request, service } = setup((_system, _user, index) =>
      index === 1
        ? completion('{"instructions":"","content":"partial', 'length')
        : completion(mapReply('', 'ok')),
    );

    const error = await clientFailure(
      service.generate(dto(longPrompt(3)), new AbortController().signal),
    );

    expect(error.getStatus()).toBe(422);
    expect(error.message).toContain('上游截断');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects a final merge response that did not finish with stop instead of returning partial text', async () => {
    const { request, service } = setup((system) =>
      system.includes(AI_TEXT_BATCH_PROMPTS.mapSystem)
        ? completion(mapReply('', 'ok'))
        : completion('{"partial":', 'length'),
    );

    const error = await clientFailure(
      service.generate(dto(longPrompt(2)), new AbortController().signal),
    );

    expect(error.getStatus()).toBe(422);
    expect(error.message).not.toContain('partial');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('cancels in-flight Axios calls of sibling batches when the caller aborts', async () => {
    const parent = new AbortController();
    const reason = new Error('user-stop');
    const request = vi.spyOn(axios, 'request').mockImplementation(
      ((config: AxiosRequestConfig) =>
        new Promise<never>((_resolve, reject) => {
          (config.signal as AbortSignal | undefined)?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        })) as unknown as typeof axios.request,
    );
    const run = track(
      new AiTextCapabilityService(new AiTextClientService()).generate(
        dto(longPrompt(6)),
        parent.signal,
      ),
    );

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    parent.abort(reason);
    await run.done;

    expect(run.state.error).toBe(reason);
    expect(configs(request).every((config) => config.signal?.aborted)).toBe(true);
    await idle();
    expect(request).toHaveBeenCalledTimes(3);
  });
});
