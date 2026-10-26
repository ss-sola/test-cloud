import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

interface State {
  status: string;
  message: string;
  outputs?: Record<string, unknown> | null;
}
interface Snapshot {
  runId: string;
  revision: number;
  running: boolean;
  status: string;
  states: Array<State & { nodeId: string }>;
  startedAt?: number;
  finishedAt?: number;
}
interface Prepared {
  document: ReturnType<typeof documentOf>;
  scope: Set<string>;
  states: Map<string, State>;
  reusedNodeIds: Set<string>;
}
interface Start {
  document: ReturnType<typeof documentOf>;
  fromNodeId?: string;
  previousOutputs?: Array<{ nodeId: string; outputs: Record<string, unknown> }>;
  onUpdate(snapshot: Snapshot, options?: { full?: boolean }): void;
}
interface Handle {
  done: Promise<Snapshot>;
  stop(): Promise<void>;
  disconnect(): void;
  reconnect?(): void;
}
interface Registry {
  registerDataType(name: string, validator: (value: unknown) => boolean): Registry;
  register(definition: Record<string, unknown>): Registry;
}
interface Runtime {
  running: boolean;
  status: string;
  runId: string;
  states: Map<string, State>;
}
interface Workspace {
  activeId: string;
  runner: { start(input: Start): Handle } | null;
  getDocument(id?: string): ReturnType<typeof documentOf>;
  getRuntime(id?: string): Runtime;
  prepareRun(nodeId?: string, id?: string): Prepared;
  restoreOutputs(items: Array<{ nodeId: string; outputs: unknown }>, id?: string): void;
  run(id?: string): Promise<unknown>;
  runFrom(nodeId: string): Promise<unknown>;
  stop(id?: string): void | Promise<void>;
  disconnectExecution(): void;
  reconnectExecution(): void;
  updateNode(nodeId: string, patch: object): void;
  setViewport(viewport: object): void;
  subscribe(listener: (...args: unknown[]) => void): () => void;
  create(name: string): { id: string };
  select(id: string): void;
}
const Core = createRequire(__filename)(resolve(__dirname, '../../public/js/workflow-core.js')) as {
  NodeRegistry: new () => Registry;
  ExecutionPool: new () => { active: number };
  Workspace: new (options: Record<string, unknown>) => Workspace;
  createExecutionPlan(document: unknown, registry: Registry): { active: Set<string> };
};

/** 可控延迟只用于验证运行锁与迟到状态，不访问外部基础设施。 */
function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolvePromise = done;
    rejectPromise = fail;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
const node = (id: string, type = 'task') => ({
  id,
  type,
  version: 1,
  name: id,
  config: type === 'entry' ? { secret: 'start-secret' } : {},
  position: { x: 0, y: 0 },
  size: { width: 200, height: 200 },
});
const edge = (from: string, to: string) => ({
  id: `${from}-${to}`,
  source: { nodeId: from, port: 'out' },
  target: { nodeId: to, port: 'in' },
});
const documentOf = (id = 'flow') => ({
  version: 1,
  id,
  name: id,
  nodes: [node('entry', 'entry'), node('up'), node('target'), node('after'), node('branch')],
  edges: [
    edge('entry', 'up'),
    edge('up', 'target'),
    edge('target', 'after'),
    edge('entry', 'branch'),
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
});
/** 所有端口用宽 JSON 类型，单独验证核心的纯 JSON、深度与预算边界。 */
function registry(handler: (id: string) => unknown = (id) => ({ out: id })) {
  const value = new Core.NodeRegistry();
  value.registerDataType('json', () => true);
  const port = (id: string) => ({ id, label: id, dataType: 'json' });
  for (const type of ['entry', 'task', 'data'])
    value.register({
      type,
      version: 1,
      execution: type === 'entry' ? 'entry' : type === 'data' ? 'data' : 'task',
      inputs: type === 'task' ? [port('in')] : [],
      outputs: [port('out')],
      defaults: {},
      localConfig: type === 'entry',
      execute: ({ node: current }: { node: { id: string } }) => handler(current.id),
    });
  return value;
}
const success = (nodeId: string, out: unknown = nodeId) => ({ nodeId, outputs: { out } });
const snapshot = (revision: number, states: Snapshot['states'], running = true): Snapshot => ({
  runId: 'remote-run',
  revision,
  states: running
    ? states
    : [
        ...states,
        ...documentOf()
          .nodes.filter((item) => !states.some((state) => state.nodeId === item.id))
          .map((item) => ({
            nodeId: item.id,
            status: 'succeeded',
            message: '',
            outputs: { out: item.id },
          })),
      ],
  running,
  status: running ? 'running' : 'succeeded',
});
/** 捕获 runner 回调，公开驱动快照，证明旧运行与异常隔离。 */
function remoteLab() {
  const inputs: Start[] = [];
  const attempts: ReturnType<typeof deferred<Snapshot>>[] = [];
  const stop = vi.fn(async () => {});
  const disconnect = vi.fn();
  const reconnect = vi.fn();
  const runner = {
    start(input: Start) {
      inputs.push(input);
      const gate = deferred<Snapshot>();
      attempts.push(gate);
      return { done: gate.promise, stop, disconnect, reconnect };
    },
  };
  const workspace = new Core.Workspace({ registry: registry(), document: documentOf(), runner });
  return { workspace, inputs, attempts, stop, disconnect, reconnect };
}

describe('独立执行核心', () => {
  it('显式 document 从不读写 storage，保留开始凭据且使用指定 runId', async () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('must not read');
      }),
      setItem: vi.fn(),
    };
    const workspace = new Core.Workspace({
      registry: registry(),
      storage,
      document: documentOf(),
      runId: 'server-id',
    });
    expect(workspace.getDocument().nodes[0].config).toEqual({ secret: 'start-secret' });
    workspace.updateNode('target', { name: 'rename' });
    workspace.setViewport({ x: 1, y: 2, zoom: 1 });
    await expect(workspace.run()).resolves.toEqual({ status: 'succeeded', runId: 'server-id' });
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(Core.createExecutionPlan(workspace.getDocument(), registry()).active.size).toBe(5);
  });

  it('prepareRun 只读且与 runFrom 共用校验，明确返回必须复用的边界', async () => {
    const calls: string[] = [];
    const workspace = new Core.Workspace({
      registry: registry((id) => (calls.push(id), { out: id })),
      document: documentOf(),
    });
    expect(() => workspace.prepareRun('target')).toThrow('没有可复用');
    expect(calls).toEqual([]);
    expect(workspace.getRuntime().running).toBe(false);
    workspace.restoreOutputs([success('up'), success('branch')]);
    const prepared = workspace.prepareRun('target');
    expect([...prepared.scope]).toEqual(['target', 'after']);
    expect([...prepared.reusedNodeIds]).toEqual(['up']);
    expect(prepared.states.get('target')?.status).toBe('queued');
    expect(workspace.getRuntime().states.has('target')).toBe(false);
    await workspace.runFrom('target');
    expect(calls).toEqual(['target', 'after']);
    expect(workspace.getRuntime().states.get('branch')?.outputs).toEqual({ out: 'branch' });
  });

  it('局部运行重新求值 entry/data，上游 task 才能复用', async () => {
    const document = documentOf();
    document.nodes = [node('entry', 'entry'), node('data', 'data'), node('target')];
    document.edges = [
      edge('entry', 'target'),
      { ...edge('data', 'target'), target: { nodeId: 'target', port: 'extra' } },
    ];
    const value = registry();
    // 为本用例注册有独立数据输入的处理节点。
    value.register({
      type: 'two-input',
      version: 1,
      inputs: [
        { id: 'in', dataType: 'json' },
        { id: 'extra', dataType: 'json' },
      ],
      outputs: [{ id: 'out', dataType: 'json' }],
      execute: () => ({ out: 'ok' }),
    });
    document.nodes[2].type = 'two-input';
    const workspace = new Core.Workspace({ registry: value, document });
    workspace.restoreOutputs([success('entry'), success('data')]);
    expect([...workspace.prepareRun('target').scope]).toEqual(['target', 'entry', 'data']);
  });

  it('restoreOutputs 严格拒绝未知端口、缺端口、类型错误、重复节点及非 JSON，原子保留旧状态', () => {
    const value = registry();
    value.register({
      type: 'text-only',
      version: 1,
      outputs: [{ id: 'text', label: '文字', dataType: 'text' }],
      execute: () => ({ text: '' }),
    });
    const document = documentOf();
    document.nodes.push(node('text', 'text-only'));
    const workspace = new Core.Workspace({ registry: value, document });
    workspace.restoreOutputs([success('branch')]);
    const before = workspace.getRuntime();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const invalid = [
      [success('target'), { nodeId: 'up', outputs: { unknown: true } }],
      [{ nodeId: 'up', outputs: {} }],
      [{ nodeId: 'text', outputs: { text: 1 } }],
      [success('up'), success('up')],
      [success('missing')],
      [success('up', undefined), { nodeId: 'after', outputs: { out: undefined } }],
      [success('up', Number.NaN)],
      [success('up', () => {})],
      [success('up', cycle)],
    ];
    for (const items of invalid) {
      expect(() => workspace.restoreOutputs(items)).toThrow(Error);
      expect(workspace.getRuntime()).toEqual(before);
    }
  });

  it('restoreOutputs 深拷贝冻结，输出深度 160 接纳、161 原子拒绝', () => {
    const workspace = new Core.Workspace({ registry: registry(), document: documentOf() });
    const shared = { rows: [1, 2] };
    workspace.restoreOutputs([success('up', shared)]);
    shared.rows.push(3);
    const output = workspace.getRuntime().states.get('up')?.outputs;
    expect(output).toEqual({ out: { rows: [1, 2] } });
    expect(Object.isFrozen((output?.out as { rows: number[] } | undefined)?.rows)).toBe(true);
    const nested = (depth: number) => {
      let result: unknown = 1;
      for (let index = 0; index < depth; index += 1) result = { child: result };
      return result;
    };
    workspace.restoreOutputs([success('up', nested(160))]);
    const before = workspace.getRuntime();
    expect(() =>
      workspace.restoreOutputs([success('target'), success('after', nested(161))]),
    ).toThrow('160');
    expect(workspace.getRuntime()).toEqual(before);
  });

  it('显式恢复结果累计受 32 MiB 预算约束，拒绝不产生部分结果', () => {
    const workspace = new Core.Workspace({ registry: registry(), document: documentOf() });
    workspace.restoreOutputs([success('branch')]);
    const before = workspace.getRuntime();
    const big = 'a'.repeat(17 * 1024 * 1024);
    expect(() => workspace.restoreOutputs([success('up', big), success('target', big)])).toThrow(
      '32 MiB',
    );
    expect(workspace.getRuntime()).toEqual(before);
  });

  it('独立执行共享冻结对象也逐端口计入序列化预算，旧本地模式仍可复用引用', async () => {
    const value = new Core.NodeRegistry();
    value.registerDataType('json', () => true);
    const shared = { text: 'a'.repeat(1024 * 1024) };
    value.register({
      type: 'entry',
      version: 1,
      execution: 'entry',
      outputs: [{ id: 'out', dataType: 'json' }],
      execute: () => ({ out: shared }),
    });
    value.register({
      type: 'relay',
      version: 1,
      inputs: [{ id: 'in', dataType: 'json' }],
      outputs: [{ id: 'out', dataType: 'json' }],
      execute: ({ inputs }: { inputs: { in: unknown } }) => ({ out: inputs.in }),
    });
    const document = documentOf();
    document.nodes = [
      node('entry', 'entry'),
      ...Array.from({ length: 39 }, (_, index) => node(`relay${index}`, 'relay')),
    ];
    document.edges = document.nodes
      .slice(1)
      .map((item, index) => edge(document.nodes[index].id, item.id));
    const server = new Core.Workspace({ registry: value, document });
    await server.run();
    const states = [...server.getRuntime().states.values()];
    expect(
      states.some((state) => state.status === 'failed' && state.message.includes('32 MiB')),
    ).toBe(true);
    const size = states.reduce(
      (total, state) =>
        total + (state.outputs ? Buffer.byteLength(JSON.stringify(state.outputs.out)) : 0),
      0,
    );
    expect(size).toBeLessThanOrEqual(32 * 1024 * 1024);
    const local = new Core.Workspace({
      registry: value,
      storage: {
        getItem: () => JSON.stringify({ version: 1, activeId: document.id, documents: [document] }),
        setItem: () => {},
      },
    });
    await expect(local.run()).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('可选秘密保护钩子覆盖恢复、本地与远程，失败不会向下游分发秘密', async () => {
    const calls: string[] = [];
    const validateOutputs = (outputs: object) => {
      if (JSON.stringify(outputs).includes('private-secret')) throw new Error('拒绝秘密输出');
    };
    const workspace = new Core.Workspace({
      registry: registry((id) => (calls.push(id), { out: id === 'up' ? 'private-secret' : id })),
      document: documentOf(),
      validateOutputs,
      sanitizeError: () => '受控错误',
    });
    expect(() => workspace.restoreOutputs([success('up', 'private-secret')])).toThrow('拒绝秘密');
    await workspace.run();
    expect(workspace.getRuntime().states.get('up')).toMatchObject({
      status: 'failed',
      message: '受控错误',
    });
    expect(calls).not.toContain('target');
    const lab = remoteLab();
    const remote = new Core.Workspace({
      registry: registry(),
      document: documentOf(),
      runner: lab.workspace.runner,
      validateOutputs,
    });
    const run = remote.run();
    lab.attempts[0].resolve(
      snapshot(
        1,
        [
          {
            nodeId: 'target',
            status: 'succeeded',
            message: '',
            outputs: { out: 'private-secret' },
          },
        ],
        false,
      ),
    );
    await expect(run).rejects.toThrow('拒绝秘密');
    expect(remote.getRuntime().states.get('target')?.outputs).toBeNull();
  });

  it('注入共享池跨独立 Workspace 限流；同步停止不提前释放忽略取消的执行器', async () => {
    const pool = new Core.ExecutionPool();
    const gate = deferred<unknown>();
    const first = new Core.Workspace({
      registry: registry(() => gate.promise),
      document: documentOf('A'),
      pool,
    });
    const second = new Core.Workspace({ registry: registry(), document: documentOf('B'), pool });
    const run = first.run();
    await tick();
    expect(pool.active).toBe(1);
    first.stop();
    expect(first.getRuntime().running).toBe(false);
    expect(pool.active).toBe(1);
    await run;
    await second.run();
    expect(pool.active).toBe(1);
    gate.resolve({ out: 'late' });
    await tick();
    expect(pool.active).toBe(0);
  });
});

describe('核心远程运行隔离', () => {
  it('完整文档含开始凭据交给 runner，运行锁、流程切换与省略输出状态更新保持', async () => {
    const lab = remoteLab();
    const run = lab.workspace.run();
    expect(lab.inputs[0].document.nodes[0].config).toEqual({ secret: 'start-secret' });
    expect(() => lab.workspace.updateNode('target', { name: 'locked' })).toThrow('正在运行');
    const other = lab.workspace.create('other');
    lab.inputs[0].onUpdate(
      snapshot(1, [
        { nodeId: 'target', status: 'succeeded', message: '', outputs: { out: 'kept' } },
      ]),
      { full: true },
    );
    lab.inputs[0].onUpdate(
      snapshot(2, [{ nodeId: 'target', status: 'succeeded', message: '当前' }]),
    );
    lab.inputs[0].onUpdate(snapshot(1, [{ nodeId: 'target', status: 'running', message: '过期' }]));
    expect(lab.workspace.activeId).toBe(other.id);
    expect(lab.workspace.getRuntime('flow').states.get('target')).toEqual({
      status: 'succeeded',
      message: '当前',
      outputs: { out: 'kept' },
    });
    expect(JSON.stringify(lab.workspace.getRuntime('flow'))).not.toContain('start-secret');
    lab.attempts[0].resolve(
      snapshot(
        3,
        [{ nodeId: 'target', status: 'succeeded', message: '', outputs: { out: 'done' } }],
        false,
      ),
    );
    await run;
    expect(lab.workspace.getRuntime('flow').running).toBe(false);
  });

  it('runFrom 只提交必须的任务边界，不覆盖其他成功分支', async () => {
    const lab = remoteLab();
    lab.workspace.restoreOutputs([success('entry'), success('up'), success('branch')]);
    const run = lab.workspace.runFrom('target');
    expect(lab.inputs[0].previousOutputs).toEqual([success('up')]);
    lab.attempts[0].resolve(
      snapshot(
        1,
        [
          { nodeId: 'target', status: 'succeeded', message: '', outputs: { out: 'new' } },
          { nodeId: 'branch', status: 'skipped', message: '', outputs: null },
        ],
        false,
      ),
    );
    await run;
    expect(lab.workspace.getRuntime().states.get('branch')?.outputs).toEqual({ out: 'branch' });
  });

  it('停止失败不解锁或取消节点，异常交调用方；disconnect 只断本地订阅且重新挂载可恢复', async () => {
    const lab = remoteLab();
    lab.stop.mockRejectedValueOnce(new Error('停止失败'));
    const run = lab.workspace.run();
    await expect(lab.workspace.stop()).rejects.toThrow('停止失败');
    expect(lab.workspace.getRuntime().running).toBe(true);
    lab.workspace.disconnectExecution();
    lab.workspace.reconnectExecution();
    expect(lab.disconnect).toHaveBeenCalledOnce();
    expect(lab.reconnect).toHaveBeenCalledOnce();
    expect(lab.stop).toHaveBeenCalledOnce();
    lab.attempts[0].resolve({ ...snapshot(1, [], false), status: 'cancelled' });
    await run;
    expect(lab.workspace.getRuntime().status).toBe('cancelled');
  });

  it('已结束旧运行回调不能覆盖新运行，视图 listener 抛错不影响远程接纳', async () => {
    const lab = remoteLab();
    lab.workspace.subscribe(() => {
      throw new Error('bad view');
    });
    const first = lab.workspace.run();
    lab.attempts[0].resolve(snapshot(1, [], false));
    await first;
    const second = lab.workspace.run();
    lab.inputs[0].onUpdate(snapshot(100, [{ nodeId: 'target', status: 'failed', message: 'old' }]));
    expect(lab.workspace.getRuntime().states.get('target')?.status).toBe('queued');
    lab.attempts[1].resolve(snapshot(1, [], false));
    await second;
  });

  it('非法服务端输出导致结果未知而不是把运行中节点判失败，及时释放等待', async () => {
    const lab = remoteLab();
    const run = lab.workspace.run();
    lab.attempts[0].resolve(
      snapshot(
        1,
        [{ nodeId: 'target', status: 'succeeded', message: '', outputs: { unknown: true } }],
        false,
      ),
    );
    await expect(run).rejects.toThrow('端口');
    expect(lab.workspace.getRuntime().status).toBe('unknown');
    expect(lab.workspace.getRuntime().running).toBe(false);
    expect(lab.workspace.getRuntime().states.get('target')?.status).toBe('queued');
  });
});
