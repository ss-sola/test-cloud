import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface State {
  nodeId: string;
  status: string;
  message: string;
  outputs?: object | null;
}
interface Confirmation {
  confirmationId: string;
  nodeId: string;
  nodeName: string;
  wikiUrl: string;
  range: string;
  values: string[][];
  expiresAt: number;
}
interface Snapshot {
  runId: string;
  revision: number;
  running: boolean;
  status: string;
  states: State[];
  confirmations?: Confirmation[];
}
interface Handle {
  done: Promise<Snapshot>;
  stop(): Promise<void>;
  disconnect(): void;
  reconnect(): void;
}
interface RunnerInput {
  document: object;
  fromNodeId?: string;
  previousOutputs?: object[];
  onUpdate(snapshot: Snapshot, options?: { full: boolean }): void;
}
interface Options {
  request(url: string, options: RequestInit): Promise<Response>;
  readCredentials?(): object;
  confirmWrite?(options: { signal: AbortSignal; values: string[][] }): Promise<boolean>;
  timing?: Record<string, number | number[]>;
}
const Client = createRequire(__filename)(
  resolve(__dirname, '../../public/js/workflow-execution.js'),
) as {
  createRunner(options: Options): { start(input: RunnerInput): Handle };
  createEventParser(listener: (event: string, snapshot: Snapshot) => void): {
    push(text: string): void;
  };
  runtimeCredentials(value: object): object;
  LIMITS: { frameBytes: number };
};
const timing = { requestMs: 1000, heartbeatMs: 100, detachedPollMs: 2, retryMs: [1, 2, 3] };
const started = {
  runId: 'run1',
  accessToken: 'ACCESS_TOKEN_PRIVATE',
  expiresAt: Date.now() + 60_000,
};
const json = (data: object, status = 200) =>
  new Response(JSON.stringify({ code: status, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const state = (status = 'running', outputs?: object): State => ({
  nodeId: 'node1',
  status,
  message: '',
  ...(outputs ? { outputs } : {}),
});
const snapshot = (revision = 0, running = true, states = [state()]): Snapshot => ({
  runId: 'run1',
  revision,
  running,
  status: running ? 'running' : 'succeeded',
  states,
  confirmations: [],
});
const confirmation = (id = 'confirm1'): Confirmation => ({
  confirmationId: id,
  nodeId: 'node1',
  nodeName: '写入',
  wikiUrl: 'https://example.feishu.cn/wiki/test?sheet=sheet1',
  range: 'A1:A1',
  values: [['中文']],
  expiresAt: Date.now() + 60_000,
});
const finalSnapshot = (revision = 3) =>
  snapshot(revision, false, [state('succeeded', { text: '最终中文结果' })]);

/** 手动控制 Promise，覆盖尚未获得 runId 时停止等竞态。 */
function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolvePromise = done;
  });
  return { promise, resolve: resolvePromise };
}
/** 本地流夹具：取消即关闭 reader，没有实际网络请求。 */
function eventStream(signal: AbortSignal | null | undefined, initial = '', close = false) {
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
    cancel() {
      ended = true;
    },
  });
  const end = () => {
    if (!ended) {
      ended = true;
      sink.close();
    }
  };
  signal?.addEventListener('abort', end, { once: true });
  if (initial) sink.enqueue(encoder.encode(initial));
  if (close || signal?.aborted) end();
  return {
    response: new Response(body, {
      headers: { 'Content-Type': 'text/event-stream;charset=utf-8' },
    }),
    send(text: string) {
      if (!ended) sink.enqueue(encoder.encode(text));
    },
    sendBytes(value: Uint8Array) {
      if (!ended) sink.enqueue(value);
    },
    end,
  };
}
const frame = (event: string, value: Snapshot) =>
  `event: ${event}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const activeHandles = new Set<Handle>();
const input = (onUpdate = vi.fn()): RunnerInput => ({
  document: { id: 'workflow', nodes: [{ config: { githubToken: 'START_SECRET' } }] },
  onUpdate,
});
/** 注册本地适配器并记录 handle，测试始终让后台进入终态，不遗留定时器。 */
function start(options: Options, runInput = input()) {
  const handle = Client.createRunner({ readCredentials: () => ({}), timing, ...options }).start(
    runInput,
  );
  activeHandles.add(handle);
  void handle.done.then(
    () => activeHandles.delete(handle),
    () => activeHandles.delete(handle),
  );
  return handle;
}
afterEach(() => {
  for (const handle of activeHandles) handle.disconnect();
  vi.useRealTimers();
});

describe('工作流远程执行协议', () => {
  it('每次完整提交凭据白名单与 dateContext，后续访问令牌仅在 header，不进入事件或 URL', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const onUpdate = vi.fn();
    const credentials = {
      githubToken: 'GH_SECRET',
      ai: {
        baseUrl: 'https://model.example/v1',
        apiKey: 'AI_SECRET',
        model: 'm',
        enableThinking: true,
        ignored: 'hidden',
      },
      feishuAppId: 'app',
      feishuAppSecret: 'FS_SECRET',
      unknown: 'hidden',
      accessToken: 'wrong',
    };
    const handle = start(
      {
        readCredentials: () => credentials,
        request: async (url, options) => {
          calls.push({ url, options });
          return json(url.endsWith('/run') ? started : finalSnapshot());
        },
      },
      input(onUpdate),
    );
    credentials.githubToken = 'changed';
    await handle.done;
    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[0].options.body));
    expect(JSON.parse(body.document).nodes[0].config.githubToken).toBe('START_SECRET');
    expect(body.runtime.githubToken).toBe('GH_SECRET');
    expect(body.runtime).not.toHaveProperty('unknown');
    expect(body.runtime).not.toHaveProperty('accessToken');
    expect(body.runtime.ai).not.toHaveProperty('ignored');
    expect(body.dateContext.now).toMatch(/Z$/);
    expect(typeof body.dateContext.timeZone).toBe('string');
    expect(body.runtime).not.toHaveProperty('dateContext');
    expect(calls[1].options.headers).toMatchObject({ 'X-Workflow-Token': started.accessToken });
    expect(
      calls.every(
        ({ url, options }) =>
          !url.includes(started.accessToken) &&
          options.cache === 'no-store' &&
          options.credentials === 'same-origin' &&
          options.redirect === 'error',
      ),
    ).toBe(true);
    expect(JSON.stringify(onUpdate.mock.calls)).not.toContain(started.accessToken);
    expect(Object.keys(handle).sort()).toEqual(['disconnect', 'done', 'reconnect', 'stop']);
  });

  it('局部重跑只提交显式 fromNodeId 与 previousOutputs，不使用导出文档替代开始凭据', async () => {
    const request = vi.fn(async (url: string, _options: RequestInit) =>
      json(url.endsWith('/run') ? started : finalSnapshot()),
    );
    const runInput = {
      ...input(),
      fromNodeId: 'node1',
      previousOutputs: [{ nodeId: 'up', outputs: { data: [1] } }],
    };
    await start({ request }, runInput).done;
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.fromNodeId).toBe('node1');
    expect(body.previousOutputs).toEqual(runInput.previousOutputs);
    expect(body.document).toContain('START_SECRET');
  });

  it('run 启动请求不明时不重试 POST，明确提示后台可能已运行', async () => {
    const request = vi.fn(async () => {
      throw new TypeError('GH_SECRET raw request');
    });
    await expect(start({ request }).done).rejects.toThrow('后台可能仍在执行');
    expect(request).toHaveBeenCalledOnce();
  });

  it('断线后 status 恢复完整结果，不改节点为 failed、不重新提交 run', async () => {
    const onUpdate = vi.fn();
    let statuses = 0;
    const request = vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith('/run')) return json(started);
      if (url.includes('/events')) return eventStream(options.signal, '', true).response;
      statuses += 1;
      if (statuses === 2) throw new TypeError('offline');
      return json(statuses < 3 ? snapshot() : finalSnapshot());
    });
    await start({ request }, input(onUpdate)).done;
    expect(request.mock.calls.filter(([url]) => url.endsWith('/run'))).toHaveLength(1);
    expect(
      onUpdate.mock.calls
        .flatMap(([value]) => value.states)
        .some((item) => item.status === 'failed'),
    ).toBe(false);
    expect(onUpdate.mock.calls.at(-1)?.[0].states[0].outputs).toEqual({ text: '最终中文结果' });
  });

  it('SSE 终态无 outputs 不直接解锁，必须等完整 status 请求返回', async () => {
    const full = deferred<Response>();
    const onUpdate = vi.fn();
    let statuses = 0;
    const request = vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith('/run')) return json(started);
      if (url.includes('/events'))
        return eventStream(options.signal, frame('run-finished', snapshot(2, false, [])), true)
          .response;
      statuses += 1;
      return statuses === 1 ? json(snapshot()) : full.promise;
    });
    const handle = start({ request }, input(onUpdate));
    let settled = false;
    void handle.done.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(statuses).toBe(2));
    expect(settled).toBe(false);
    full.resolve(json(finalSnapshot()));
    await handle.done;
    expect(onUpdate.mock.calls.at(-1)?.[1]).toEqual({ full: true });
  });

  it('多个成功节点保留同一 SSE，只按 nodeId 补输出；旧全局 revision 结果不回退新状态或确认', async () => {
    const onUpdate = vi.fn();
    const oldOutput = deferred<Response>();
    const streamReady = deferred<ReturnType<typeof eventStream>>();
    let finished = false;
    const request = vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith('/run')) return json(started);
      if (url.includes('/events')) {
        const stream = eventStream(options.signal);
        streamReady.resolve(stream);
        return stream.response;
      }
      if (url.includes('&nodeId=node1')) return oldOutput.promise;
      if (url.includes('&nodeId=node2'))
        return json(
          snapshot(3, true, [{ ...state('succeeded', { text: 'second' }), nodeId: 'node2' }]),
        );
      if (url.endsWith('/confirm')) return json({});
      return json(
        finished
          ? snapshot(5, false, [
              state('succeeded', { text: 'first' }),
              { ...state('succeeded', { text: 'second' }), nodeId: 'node2' },
            ])
          : snapshot(),
      );
    });
    const confirmWrite = vi.fn(async () => true);
    const handle = start(
      { request, confirmWrite, timing: { ...timing, heartbeatMs: 10_000 } },
      input(onUpdate),
    );
    const stream = await streamReady.promise;
    stream.send(
      frame('node-state', snapshot(1, true, [{ ...state('succeeded'), message: '保留成功状态' }])),
    );
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([url]) => url.includes('&nodeId=node1'))).toBe(true),
    );
    stream.send(
      frame(
        'node-state',
        snapshot(2, true, [{ ...state(), nodeId: 'node2', message: '较新的状态' }]),
      ),
    );
    await vi.waitFor(() =>
      expect(onUpdate.mock.calls.some(([value]) => value.revision === 2)).toBe(true),
    );
    oldOutput.resolve(json(snapshot(1, true, [state('succeeded', { text: 'first' })])));
    await vi.waitFor(() =>
      expect(
        onUpdate.mock.calls.some(([value]) => value.states[0]?.outputs?.text === 'first'),
      ).toBe(true),
    );
    const filled = onUpdate.mock.calls.find(
      ([value]) => value.states[0]?.outputs?.text === 'first',
    )?.[0];
    expect(filled).toMatchObject({
      revision: 2,
      states: [
        {
          nodeId: 'node1',
          status: 'succeeded',
          message: '保留成功状态',
          outputs: { text: 'first' },
        },
      ],
    });
    expect(filled).not.toHaveProperty('confirmations');
    expect(filled).not.toHaveProperty('startedAt');
    stream.send(
      frame('node-state', snapshot(3, true, [{ ...state('succeeded'), nodeId: 'node2' }])),
    );
    stream.send(
      frame('confirmations', { ...snapshot(4, true, []), confirmations: [confirmation()] }),
    );
    await vi.waitFor(() =>
      expect(
        onUpdate.mock.calls.some(([value]) => value.states[0]?.outputs?.text === 'second'),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(confirmWrite).toHaveBeenCalledOnce());
    finished = true;
    stream.send(frame('run-finished', snapshot(5, false, [])));
    await handle.done;
    expect(request.mock.calls.filter(([url]) => url.includes('/events'))).toHaveLength(1);
    const statuses = request.mock.calls.filter(([url]) => url.includes('/status'));
    expect(statuses.filter(([url]) => !url.includes('&nodeId='))).toHaveLength(2);
    expect(statuses.filter(([url]) => url.includes('&nodeId='))).toHaveLength(2);
    const incremental = onUpdate.mock.calls.find(
      ([value, options]) => value.revision === 1 && !options.full,
    );
    expect(incremental?.[0].states[0]).not.toHaveProperty('outputs');
  });

  it('旧 revision 和旧 runId 不覆盖最新状态，协议错配不能伪装成合法任务', async () => {
    const onUpdate = vi.fn();
    let statuses = 0;
    const request = async (url: string, options: RequestInit) => {
      if (url.endsWith('/run')) return json(started);
      if (url.includes('/events'))
        return eventStream(
          options.signal,
          frame('snapshot', snapshot(4)) +
            frame('node-state', snapshot(3, true, [state('failed')])) +
            frame('run-finished', snapshot(5, false, [])),
          true,
        ).response;
      statuses += 1;
      return json(statuses === 1 ? snapshot(2) : finalSnapshot(5));
    };
    await start({ request }, input(onUpdate)).done;
    expect(onUpdate.mock.calls.map(([value]) => value.revision)).toEqual([2, 4, 5, 5]);
    await expect(
      start({
        request: async (url) =>
          json(url.endsWith('/run') ? started : { ...finalSnapshot(), runId: 'wrong' }),
      }).done,
    ).rejects.toThrow('无效状态');
  });

  it('状态恢复退避有上限，短暂 500 不报告结果丢失', async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const startAt = Date.now();
    let attempts = 0;
    const request = async (url: string) => {
      if (url.endsWith('/run')) return json(started);
      times.push(Date.now() - startAt);
      attempts += 1;
      return attempts < 5 ? new Response('', { status: 500 }) : json(finalSnapshot());
    };
    const handle = start({ request, timing: { ...timing, retryMs: [10, 20] } });
    await vi.advanceTimersByTimeAsync(100);
    await handle.done;
    expect(times).toEqual([0, 10, 30, 50, 70]);
  });

  it('服务端明确 404 才报告状态丢失，错误正文与凭据不回显', async () => {
    const request = async (url: string) =>
      url.endsWith('/run') ? json(started) : new Response('PRIVATE_RAW_SECRET', { status: 404 });
    await expect(start({ request }).done).rejects.toThrow('状态已丢失或过期');
  });

  it('启动尚未获得 runId 时 stop 等待后补发 POST，终态完整读取后才结束', async () => {
    const startup = deferred<Response>();
    let cancelled = false;
    const calls: string[] = [];
    const stopBodies: unknown[] = [];
    const request = async (url: string, options: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/run')) return startup.promise;
      if (url.endsWith('/stop')) {
        cancelled = true;
        stopBodies.push(JSON.parse(String(options.body)));
        return json({});
      }
      if (url.includes('/events')) return eventStream(options.signal, '', true).response;
      return json(cancelled ? { ...finalSnapshot(), status: 'cancelled' } : snapshot());
    };
    const handle = start({ request });
    const stopping = handle.stop();
    expect(calls).toEqual(['/api/workflow/run']);
    startup.resolve(json(started));
    await stopping;
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(calls.filter((url) => url.endsWith('/stop'))).toHaveLength(1);
    expect(stopBodies).toEqual([{ runId: 'run1' }]);
  });

  it('停止失败保持订阅和 done，允许重试停止，不把后台执行当 cancelled', async () => {
    let stopped = false;
    let stopCalls = 0;
    let streams = 0;
    const request = async (url: string, options: RequestInit) => {
      if (url.endsWith('/run')) return json(started);
      if (url.endsWith('/stop')) {
        stopCalls += 1;
        if (stopCalls === 1) throw new TypeError('offline secret');
        stopped = true;
        return json({});
      }
      if (url.includes('/events')) {
        streams += 1;
        return eventStream(options.signal).response;
      }
      return json(stopped ? { ...finalSnapshot(), status: 'cancelled' } : snapshot());
    };
    const handle = start({ request });
    await vi.waitFor(() => expect(streams).toBe(1));
    await expect(handle.stop()).rejects.toThrow('后台可能仍在运行');
    let done = false;
    void handle.done.then(() => {
      done = true;
    });
    expect(done).toBe(false);
    await handle.stop();
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('disconnect 不 stop 后台，仍以状态轮询收敛；reconnect 只恢复订阅', async () => {
    let finished = false;
    let streams = 0;
    const calls: string[] = [];
    const request = async (url: string, options: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/run')) return json(started);
      if (url.includes('/events')) {
        streams += 1;
        return eventStream(options.signal).response;
      }
      return json(finished ? finalSnapshot() : snapshot());
    };
    const handle = start({ request });
    await vi.waitFor(() => expect(streams).toBe(1));
    handle.disconnect();
    handle.reconnect();
    await vi.waitFor(() => expect(streams).toBe(2));
    handle.disconnect();
    finished = true;
    await handle.done;
    expect(calls.filter((url) => url.endsWith('/run'))).toHaveLength(1);
    expect(calls.some((url) => url.endsWith('/stop'))).toBe(false);
  });

  it('心跳超时中止静默流并 status 恢复，不无限挂起 reader', async () => {
    let statuses = 0;
    const request = async (url: string, options: RequestInit) => {
      if (url.endsWith('/run')) return json(started);
      if (url.includes('/events')) return eventStream(options.signal).response;
      statuses += 1;
      return json(statuses === 1 ? snapshot() : finalSnapshot());
    };
    await start({ request, timing: { ...timing, heartbeatMs: 5 } }).done;
    expect(statuses).toBe(2);
  });
});

describe('确认授权生命周期', () => {
  it('同一 confirmationId 跨快照、重连只确认一次，显式 accepted=true 才提交', async () => {
    let confirmed = false;
    let streams = 0;
    const confirmWrite = vi.fn(async () => true);
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const pending = { ...snapshot(), confirmations: [confirmation()] };
    const request = async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      if (url.endsWith('/run')) return json(started);
      if (url.endsWith('/confirm')) {
        confirmed = true;
        return json({});
      }
      if (url.includes('/events')) {
        streams += 1;
        return eventStream(
          options.signal,
          frame('snapshot', { ...pending, revision: streams }),
          true,
        ).response;
      }
      return json(confirmed && streams ? finalSnapshot(10) : pending);
    };
    await start({ request, confirmWrite }).done;
    expect(confirmWrite).toHaveBeenCalledOnce();
    const submission = calls.filter((call) => call.url.endsWith('/confirm'));
    expect(submission).toHaveLength(1);
    expect(JSON.parse(String(submission[0].options.body))).toEqual({
      runId: 'run1',
      confirmationId: 'confirm1',
      accepted: true,
    });
  });

  it('显式拒绝只回传 accepted=false，不隐式批准写入', async () => {
    let submitted = false;
    let submittedBody: unknown;
    const request = async (url: string, options: RequestInit) => {
      if (url.endsWith('/run')) return json(started);
      if (url.endsWith('/confirm')) {
        submitted = true;
        submittedBody = JSON.parse(String(options.body));
        return json({});
      }
      if (url.includes('/events')) return eventStream(options.signal, '', true).response;
      return json(
        submitted
          ? { ...finalSnapshot(), status: 'failed' }
          : { ...snapshot(), confirmations: [confirmation()] },
      );
    };
    await start({ request, confirmWrite: async () => false }).done;
    expect(submittedBody).toEqual({ runId: 'run1', confirmationId: 'confirm1', accepted: false });
  });

  it('消失的确认取消模态，abort 解析 false 也不回传，陈旧确认不能写入', async () => {
    let statuses = 0;
    let signal: AbortSignal | null = null;
    const calls: string[] = [];
    const confirmWrite = vi.fn(
      ({ signal: current }: { signal: AbortSignal }) =>
        new Promise<boolean>((resolvePromise) => {
          signal = current;
          current.addEventListener('abort', () => resolvePromise(false), { once: true });
        }),
    );
    const request = async (url: string, options: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/run')) return json(started);
      if (url.includes('/events'))
        return eventStream(
          options.signal,
          frame('confirmations', { ...snapshot(1), confirmations: [] }),
          true,
        ).response;
      statuses += 1;
      return json(
        statuses === 1 ? { ...snapshot(), confirmations: [confirmation()] } : finalSnapshot(),
      );
    };
    await start({ request, confirmWrite }).done;
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(calls.some((url) => url.endsWith('/confirm'))).toBe(false);
  });

  it('disconnect 取消等待中的模态，不把取消当拒绝提交；detach 后任务仍完成', async () => {
    let finished = false;
    let signal: AbortSignal | null = null;
    const requests: string[] = [];
    const request = async (url: string, options: RequestInit) => {
      requests.push(url);
      if (url.endsWith('/run')) return json(started);
      if (url.includes('/events')) return eventStream(options.signal).response;
      return json(finished ? finalSnapshot() : { ...snapshot(), confirmations: [confirmation()] });
    };
    const confirmWrite = ({ signal: current }: { signal: AbortSignal }) =>
      new Promise<boolean>((resolvePromise) => {
        signal = current;
        current.addEventListener('abort', () => resolvePromise(false));
      });
    const handle = start({ request, confirmWrite });
    await vi.waitFor(() => expect(signal).not.toBeNull());
    handle.disconnect();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    finished = true;
    await handle.done;
    expect(requests.some((url) => url.endsWith('/confirm') || url.endsWith('/stop'))).toBe(false);
  });
});

describe('SSE 分帧边界', () => {
  it('逐字节 UTF-8、多 chunk CRLF、注释与多行 data 正确解析', () => {
    const received: Snapshot[] = [];
    const parser = Client.createEventParser((_event, value) => received.push(value));
    const expected = finalSnapshot();
    const text = `: heartbeat\r\n\r\nevent: snapshot\r\ndata: ${JSON.stringify(expected).replace(',"states"', ',\r\ndata: "states"')}\r\n\r\n`;
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const byte of bytes) parser.push(decoder.decode(Uint8Array.of(byte), { stream: true }));
    parser.push(decoder.decode());
    expect(received).toEqual([expected]);
  });

  it('帧累计预算包括未结束行、多行、未知字段；超限不继续解析', () => {
    const parser = Client.createEventParser(vi.fn());
    parser.push('data: ');
    expect(() => parser.push('x'.repeat(Client.LIMITS.frameBytes))).toThrow('帧预算');
    const multiline = Client.createEventParser(vi.fn());
    multiline.push('unknown: x\n'.repeat(1000));
    expect(() => multiline.push('y'.repeat(Client.LIMITS.frameBytes))).toThrow('帧预算');
  });

  it('错误 JSON 不回显服务端原文；不把未知事件执行为状态', () => {
    const listener = vi.fn();
    const parser = Client.createEventParser(listener);
    parser.push('event: arbitrary\ndata: not-json\n\n');
    expect(listener).not.toHaveBeenCalled();
    expect(() => parser.push('event: snapshot\ndata: SECRET_BROKEN_JSON\n\n')).toThrow(
      '事件格式无效',
    );
  });
});
