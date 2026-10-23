import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ *
 * 工作流无 DOM 核心行为测试。
 * 核心是浏览器/Node 双用的 CJS 脚本；这里只通过公开接口驱动，所有执行器都是可控
 * Promise，不发起任何真实网络请求。
 * ------------------------------------------------------------------ */

interface Port {
  id: string;
  label: string;
  dataType: string;
  required?: boolean;
  kind?: 'control' | 'data';
}
interface WorkflowNode {
  id: string;
  type: string;
  version: number;
  name: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  config: Record<string, unknown>;
}
interface WorkflowEdge {
  id: string;
  source: { nodeId: string; port: string };
  target: { nodeId: string; port: string };
}
interface WorkflowDocument {
  version: number;
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: { x: number; y: number; zoom: number };
}
interface ExecuteContext {
  node: WorkflowNode;
  inputs: Record<string, unknown>;
  controls: Record<string, unknown>;
  services: unknown;
  signal: AbortSignal;
  suspend<T>(work: () => Promise<T>): Promise<T>;
}
interface NodeDefinition {
  type: string;
  version: number;
  label: string;
  category: string;
  execution?: 'entry' | 'data' | 'task';
  inputs: Port[];
  outputs: Port[];
  defaults: Record<string, unknown>;
  size?: { width: number; height: number };
  localConfig?: boolean;
  validateConfig?(config: Record<string, unknown>): string | null | undefined;
  migrate?(config: Record<string, unknown>): Record<string, unknown>;
  execute(context: ExecuteContext): unknown;
}
interface Registry {
  register(definition: NodeDefinition): Registry;
  registerDataType(
    name: string,
    validate: (value: unknown) => boolean,
    options?: { base?: string },
  ): Registry;
  compatible(output: string, input: string): boolean;
  get(type: string, version?: number): NodeDefinition | undefined;
  list(): NodeDefinition[];
}
interface Connection {
  id?: string;
  allowUnknown?: boolean;
  source: { nodeId: string; port: string };
  target: { nodeId: string; port: string };
}
interface NodeState {
  status: string;
  message: string;
  outputs: Record<string, unknown> | null;
}
interface Runtime {
  running: boolean;
  status: string;
  states: Map<string, NodeState>;
  startedAt: number | null;
  finishedAt: number | null;
}
interface WorkspaceEvent {
  kind: string;
  nodeIds?: string[];
}
interface WorkspaceApi {
  readonly documents: readonly WorkflowDocument[];
  readonly activeId: string;
  getDocument(id?: string): WorkflowDocument;
  getRuntime(id?: string): Runtime;
  subscribe(listener: (id: string, event: WorkspaceEvent) => void): () => void;
  create(name?: string): WorkflowDocument;
  select(id: string): void;
  rename(id: string, name: string): WorkflowDocument;
  duplicate(id: string): WorkflowDocument;
  remove(id: string): void;
  importDocument(raw: unknown, options?: { preserveName?: boolean }): WorkflowDocument;
  exportDocument(id?: string): string;
  addNode(type: string, position: { x: number; y: number }): WorkflowNode;
  updateNode(nodeId: string, patch: Partial<WorkflowNode>, documentId?: string): WorkflowDocument;
  deleteSelection(selection: { nodeIds?: string[]; edgeIds?: string[] }, documentId?: string): void;
  copySelection(nodeIds: string[], documentId?: string): WorkflowNode[];
  insertSubgraph(
    graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
    documentId?: string,
  ): WorkflowNode[];
  updateLayout(
    updates: Array<{
      id: string;
      position?: { x: number; y: number };
      size?: { width: number; height: number };
    }>,
    documentId?: string,
  ): WorkflowDocument;
  connect(connection: Connection, documentId?: string): WorkflowEdge;
  disconnect(edgeId: string, documentId?: string): void;
  setViewport(viewport: WorkflowDocument['viewport'], documentId?: string): void;
  undo(id?: string): void;
  redo(id?: string): void;
  canUndo(id?: string): boolean;
  canRedo(id?: string): boolean;
  run(id?: string): Promise<{ status: string; runId: string }>;
  runFrom(nodeId: string, id?: string): Promise<{ status: string; runId: string }>;
  upgradeNode(nodeId: string, id?: string): WorkflowDocument;
  stop(id?: string): void;
}
interface CoreModule {
  LIMITS: Readonly<Record<string, number>>;
  STORAGE_KEY: string;
  NodeRegistry: new () => Registry;
  Workspace: new (options: {
    registry: Registry;
    storage?: unknown;
    services?: unknown;
    onStorageError?: (message: string) => void;
  }) => WorkspaceApi;
  parseDocument(raw: unknown, registry: Registry): WorkflowDocument;
  validateConnection(
    document: WorkflowDocument,
    registry: Registry,
    connection: Connection,
  ): string | null;
  withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
}

const core = createRequire(__filename)(
  resolve(__dirname, '../../public/js/workflow-core.js'),
) as CoreModule;
const {
  LIMITS,
  STORAGE_KEY,
  NodeRegistry,
  Workspace,
  parseDocument,
  validateConnection,
  withAbort,
} = core;

/* ------------------------------ 夹具 ------------------------------ */

type Handler = (context: ExecuteContext) => unknown;
interface Deferred<T = unknown> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = unknown>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolvePromise = ok;
    rejectPromise = fail;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const tick = (): Promise<void> => new Promise((done) => setImmediate(done));

const nodeOf = (
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  version = 1,
): WorkflowNode => ({
  id,
  type,
  version,
  name: id,
  position: { x: 0, y: 0 },
  size: { width: 200, height: 200 },
  config,
});
const src = (id: string, value = id): WorkflowNode => nodeOf(id, 'src', { value });
const task = (id: string): WorkflowNode => nodeOf(id, 'task');
const edgeOf = (from: string, to: string, toPort = 'in', fromPort = 'out'): WorkflowEdge => ({
  id: `${from}-${to}-${toPort}`,
  source: { nodeId: from, port: fromPort },
  target: { nodeId: to, port: toPort },
});
const conn = (from: string, fromPort: string, to: string, toPort: string): Connection => ({
  source: { nodeId: from, port: fromPort },
  target: { nodeId: to, port: toPort },
});
const docOf = (
  id: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[] = [],
): WorkflowDocument => ({
  version: 1,
  id,
  name: id,
  nodes,
  edges,
  viewport: { x: 0, y: 0, zoom: 1 },
});
const nested = (depth: number): Record<string, unknown> => {
  let value: unknown = 1;
  for (let i = 0; i < depth; i += 1) value = { a: value };
  return value as Record<string, unknown>;
};
const text = (id: string, required = true): Port => ({ id, label: id, dataType: 'text', required });
/** 控制端口：触发数据类型为 trigger，kind 为 control；输入侧可选。 */
const ctlPort = (required = false): Port => ({
  id: 'ctl',
  label: 'ctl',
  dataType: 'trigger',
  kind: 'control',
  required,
});
const ENTRY_ID = 'entry0';
const entryNode = (id = ENTRY_ID): WorkflowNode => nodeOf(id, 'entry');
const note = (id: string, value = id): WorkflowNode => nodeOf(id, 'note', { value });
const ctlEdge = (to: string, from = ENTRY_ID): WorkflowEdge => edgeOf(from, to, 'ctl', 'ctl');

class MemoryStorage {
  readonly data = new Map<string, string>();
  failWrites = false;
  failReads = false;
  readonly setItem = vi.fn((key: string, value: string) => {
    if (this.failWrites) throw new Error('quota');
    this.data.set(key, value);
  });
  getItem(key: string): string | null {
    if (this.failReads) throw new Error('denied');
    return this.data.get(key) ?? null;
  }
}

/** 注册一组可控节点类型，并把所有执行器记录到 calls，便于断言“是否真的执行”。 */
class Lab {
  readonly registry = new NodeRegistry();
  readonly handlers = new Map<string, Handler>();
  readonly calls: string[] = [];
  readonly errors: string[] = [];
  readonly events: Array<{ id: string } & WorkspaceEvent> = [];
  readonly services = { marker: randomUUID() };
  storage = new MemoryStorage();

  constructor() {
    this.registry.registerDataType('number', (value) => typeof value === 'number');
    this.registry.registerDataType('list', (value) => Array.isArray(value));
    this.registry.registerDataType('trigger', (value) => value === true);
    const join = ({ inputs }: ExecuteContext): string => Object.values(inputs).join('+');
    // 入口不进 calls，便于断言“业务节点是否真的执行”；可用 handlers 覆盖入口行为
    this.registry.register({
      type: 'entry',
      version: 1,
      label: 'entry',
      category: 'test',
      execution: 'entry',
      inputs: [],
      outputs: [ctlPort()],
      defaults: {},
      size: { width: 200, height: 200 },
      execute: (context) =>
        (this.handlers.get(context.node.id) ?? (() => ({ ctl: true })))(context),
    });
    this.define(
      'note',
      [],
      [text('out')],
      { value: '' },
      ({ node }) => ({ out: node.config.value }),
      undefined,
      1,
      'data',
    );
    this.define(
      'src',
      [],
      [text('out')],
      { value: '' },
      ({ node }) => ({ out: node.config.value }),
      (config) =>
        typeof config.value === 'string' && config.value.length <= LIMITS.textLength
          ? null
          : '配置无效',
    );
    this.define('task', [text('in')], [text('out')], {}, (context) => ({
      out: `${context.node.id}<${join(context)}`,
    }));
    this.define('join', [text('a'), text('b')], [text('out')], {}, (context) => ({
      out: join(context),
    }));
    this.define('opt', [text('in'), text('extra', false)], [text('out')], {}, (context) => ({
      out: join(context),
    }));
    this.define('num', [], [{ id: 'out', label: 'out', dataType: 'number' }], {}, () => ({
      out: 1,
    }));
    this.define('bag', [], [{ id: 'out', label: 'out', dataType: 'list' }], {}, () => ({
      out: [],
    }));
    this.define(
      'special',
      [text('constructor'), text('toString', false)],
      [text('valueOf')],
      {},
      ({ inputs }) => ({
        valueOf: String(inputs.constructor),
      }),
    );
    this.define('versioned', [], [text('out')], {}, () => ({ out: 'v1' }), undefined, 1);
    this.define('versioned', [], [text('out')], {}, () => ({ out: 'v2' }), undefined, 2);
  }

  private define(
    type: string,
    inputs: Port[],
    outputs: Port[],
    defaults: Record<string, unknown>,
    fallback: Handler,
    validateConfig?: NodeDefinition['validateConfig'],
    version = 1,
    execution: 'task' | 'data' = 'task',
  ): void {
    this.registry.register({
      type,
      version,
      label: `${type}@${version}`,
      category: 'test',
      execution,
      inputs: execution === 'task' ? [...inputs, ctlPort()] : inputs,
      outputs,
      defaults,
      size: { width: 200, height: 200 },
      validateConfig,
      execute: (context) => {
        this.calls.push(context.node.id);
        return (this.handlers.get(context.node.id) ?? fallback)(context);
      },
    });
  }

  /** 以固定标识的草稿启动工作区，便于直接引用节点。 */
  open(documents: WorkflowDocument[]): WorkspaceApi {
    this.storage.data.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, activeId: documents[0].id, documents }),
    );
    return this.reopen();
  }

  /** 执行用例专用：在节点末尾追加开始节点，并把 control 连到所有已注册的根节点，保持原测试图的触发语义。 */
  openRun(documents: WorkflowDocument[]): WorkspaceApi {
    return this.open(documents.map((document) => this.withEntry(document)));
  }

  /** 为文档追加开始节点；节点顺序保持不变，未注册节点没有控制端口因此不连线。 */
  withEntry(document: WorkflowDocument): WorkflowDocument {
    const targeted = new Set(document.edges.map((edge) => edge.target.nodeId));
    const roots = document.nodes.filter((node) => {
      const definition = this.registry.get(node.type, node.version);
      return definition !== undefined && definition.execution !== 'data' && !targeted.has(node.id);
    });
    return {
      ...document,
      nodes: [...document.nodes, entryNode()],
      edges: [...document.edges, ...roots.map((node) => ctlEdge(node.id))],
    };
  }

  /** 以当前存储内容重新创建工作区，模拟刷新页面。 */
  reopen(): WorkspaceApi {
    const workspace = new Workspace({
      registry: this.registry,
      storage: this.storage,
      services: this.services,
      onStorageError: (message) => this.errors.push(message),
    });
    workspace.subscribe((id, event) => this.events.push({ id, ...event }));
    return workspace;
  }

  /** 让节点停在手动控制的 Promise 上。 */
  gate(nodeId: string): Deferred {
    const gate = deferred();
    this.handlers.set(nodeId, () => gate.promise);
    return gate;
  }

  /** 状态快照，用于证明失败操作没有任何副作用。 */
  snapshot(workspace: WorkspaceApi): unknown {
    return {
      documents: workspace.documents,
      activeId: workspace.activeId,
      writes: this.storage.setItem.mock.calls.length,
      events: this.events.length,
      canUndo: workspace.canUndo(),
      canRedo: workspace.canRedo(),
    };
  }
}

const status = (workspace: WorkspaceApi, nodeId: string, documentId?: string): string | undefined =>
  workspace.getRuntime(documentId).states.get(nodeId)?.status;

let lab: Lab;
beforeEach(() => {
  lab = new Lab();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------ 注册与版本 ------------------------------ */

describe('NodeRegistry', () => {
  const definition = (patch: Record<string, unknown> = {}): NodeDefinition =>
    ({
      type: 'custom',
      version: 1,
      label: 'custom',
      category: 'test',
      inputs: [],
      outputs: [],
      defaults: {},
      execute: () => ({}),
      ...patch,
    }) as NodeDefinition;

  it('按精确版本查找，不回退到其他版本，节点库只列最新版本', () => {
    const v1 = lab.registry.get('versioned', 1);
    const v2 = lab.registry.get('versioned', 2);
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    expect(v1).not.toBe(v2);
    expect(lab.registry.get('versioned', 3)).toBeUndefined();
    expect(lab.registry.get('versioned')).toBe(v1);
    const listed = lab.registry.list().filter((item) => item.type === 'versioned');
    expect(listed.map((item) => item.version)).toEqual([2]);
  });

  it('addNode 使用最新版本，而旧版本文档节点仍运行各自的执行器', async () => {
    const workspace = lab.openRun([docOf('A', [nodeOf('old', 'versioned', {}, 1)])]);
    const created = workspace.addNode('versioned', { x: 10, y: 10 });
    expect(created.version).toBe(2);
    workspace.connect(conn(ENTRY_ID, 'ctl', created.id, 'ctl')); // 新增节点不在开始节点触发范围内，需显式连接
    await workspace.run();
    const states = workspace.getRuntime().states;
    expect(states.get('old')?.outputs).toEqual({ out: 'v1' });
    expect(states.get(created.id)?.outputs).toEqual({ out: 'v2' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['版本为 0', { version: 0 }],
    ['版本非整数', { version: 1.5 }],
    ['类型标识非法', { type: '../x' }],
    ['缺少执行器', { execute: undefined }],
    ['输入端口重复', { inputs: [text('p'), text('p')] }],
    ['端口数据类型未注册', { outputs: [{ id: 'o', label: 'o', dataType: 'unknown-type' }] }],
    ['端口标识非法', { inputs: [text('bad id')] }],
    ['execution 取值非法', { execution: 'boss' }],
    ['端口 kind 非法', { inputs: [{ ...text('p'), kind: 'weird' }] }],
    ['入口带输入端口', { execution: 'entry', inputs: [text('p')], outputs: [text('o')] }],
    ['入口没有任何输出', { execution: 'entry' }],
    ['被动数据来源带输入端口', { execution: 'data', inputs: [text('p')], outputs: [text('o')] }],
  ])('拒绝无效定义：%s', (_name, patch) => {
    expect(() => lab.registry.register(definition(patch))).toThrow(Error);
  });

  it('拒绝重复的节点版本和重复的数据类型，包括内置 text', () => {
    lab.registry.register(definition());
    expect(() => lab.registry.register(definition())).toThrow(Error);
    expect(() => lab.registry.registerDataType('number', () => true)).toThrow(Error);
    expect(() => lab.registry.registerDataType('text', () => true)).toThrow(Error);
  });

  it('注册后与调用方传入的端口数组隔离，并且定义只读', () => {
    const inputs = [text('p')];
    lab.registry.register(definition({ inputs }));
    inputs.push(text('late'));
    const registered = lab.registry.get('custom');
    expect(registered?.inputs).toHaveLength(1);
    expect(Object.isFrozen(registered?.inputs)).toBe(true);
    expect(Object.isFrozen(registered)).toBe(true);
  });
});

/* ------------------------------ 连线校验 ------------------------------ */

describe('连线规则', () => {
  const base = (): WorkflowDocument =>
    parseDocument(
      docOf(
        'A',
        [src('s'), src('s2'), task('t'), nodeOf('j', 'join'), nodeOf('n', 'num')],
        [edgeOf('s', 't')],
      ),
      lab.registry,
    );

  it.each<[string, Connection, boolean]>([
    ['同一输出分发到多个输入', conn('s', 'out', 'j', 'a'), true],
    ['不同来源汇合到不同输入', conn('s2', 'out', 'j', 'b'), true],
    ['一个输入接入第二个来源', conn('s2', 'out', 't', 'in'), false],
    ['重复的同一条边', conn('s', 'out', 't', 'in'), false],
    ['自连接', conn('t', 'out', 't', 'in'), false],
    ['输入端口作为起点', conn('t', 'in', 'j', 'a'), false],
    ['输出端口作为终点', conn('s', 'out', 's2', 'out'), false],
    ['数据类型不兼容', conn('n', 'out', 'j', 'b'), false],
    ['起点节点不存在', conn('ghost', 'out', 't', 'in'), false],
    ['端口不存在', conn('s', 'nope', 'j', 'a'), false],
  ])('预检：%s', (_name, connection, valid) => {
    const document = base();
    const before = JSON.stringify(document);
    const error = validateConnection(document, lab.registry, connection);
    expect(error === null).toBe(valid);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('校验已存在的边时排除其自身，不把自己当作第二个来源', () => {
    const document = base();
    expect(
      validateConnection(document, lab.registry, { id: 's-t-in', ...conn('s', 'out', 't', 'in') }),
    ).toBeNull();
  });

  it('拒绝形成环路的连线；移除链路中的一条边后同一连线合法', () => {
    const workspace = lab.open([
      docOf('A', [task('x'), task('y'), task('z')], [edgeOf('x', 'y'), edgeOf('y', 'z')]),
    ]);
    const closing = conn('z', 'out', 'x', 'in');
    expect(() => workspace.connect(closing)).toThrow(Error);
    workspace.disconnect('y-z-in');
    expect(() => workspace.connect(closing)).not.toThrow(Error);
  });

  it('成功连线可撤销重做，并且产生 structure 事件', () => {
    const workspace = lab.open([docOf('A', [src('s'), task('t')])]);
    const edge = workspace.connect(conn('s', 'out', 't', 'in'));
    expect(workspace.getDocument().edges).toEqual([edge]);
    expect(lab.events.at(-1)).toMatchObject({ id: 'A', kind: 'structure' });
    workspace.undo();
    expect(workspace.getDocument().edges).toEqual([]);
    workspace.redo();
    expect(workspace.getDocument().edges).toEqual([edge]);
  });

  describe('失败的修改是原子的', () => {
    const failing: Array<[string, (workspace: WorkspaceApi) => unknown]> = [
      ['环路', (w) => w.connect(conn('z', 'out', 'x', 'in'))],
      ['类型不兼容', (w) => w.connect(conn('n', 'out', 'x', 'in'))],
      ['单输入多源', (w) => w.connect(conn('s', 'out', 'y', 'in'))],
      ['自连接', (w) => w.connect(conn('x', 'out', 'x', 'in'))],
      ['坐标越界', (w) => w.updateNode('x', { position: { x: LIMITS.coordinate + 1, y: 0 } })],
      ['尺寸越界', (w) => w.updateNode('x', { size: { width: LIMITS.minSize - 1, height: 200 } })],
      ['已知节点配置无效', (w) => w.updateNode('s', { config: { value: 1 } })],
      ['节点不存在', (w) => w.updateNode('missing', { name: 'x' })],
      ['未注册节点类型', (w) => w.addNode('not-registered', { x: 0, y: 0 })],
      ['新增节点坐标越界', (w) => w.addNode('src', { x: Number.NaN, y: 0 })],
    ];

    it.each(failing)('%s不改变文档、历史、存储和事件', (_name, operation) => {
      const workspace = lab.open([
        docOf(
          'A',
          [src('s'), nodeOf('n', 'num'), task('x'), task('y'), task('z')],
          [edgeOf('x', 'y'), edgeOf('y', 'z')],
        ),
      ]);
      const before = lab.snapshot(workspace);
      expect(() => operation(workspace)).toThrow(Error);
      expect(lab.snapshot(workspace)).toEqual(before);
    });
  });
});

/* ------------------------------ 缺失与空串 ------------------------------ */

describe('输出与输入的缺失/空串', () => {
  it('空字符串是有效输出，并作为自有输入传给下游', async () => {
    const workspace = lab.openRun([docOf('A', [src('s', ''), task('t')], [edgeOf('s', 't')])]);
    let received: Record<string, unknown> = {};
    lab.handlers.set('t', ({ inputs }) => {
      received = inputs;
      return { out: '' };
    });
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(Object.hasOwn(received, 'in')).toBe(true);
    expect(received.in).toBe('');
  });

  it.each<[string, unknown]>([
    ['返回非对象', 'text'],
    ['返回 null', null],
    ['缺少声明的输出', {}],
    ['只有继承的输出', Object.create({ out: 'inherited' })],
    ['输出类型错误', { out: 1 }],
    ['输出超过文本上限', { out: 'x'.repeat(LIMITS.textLength + 1) }],
  ])('执行器%s时节点失败并跳过下游；成功的上游任务使整体为 partial', async (_name, result) => {
    const workspace = lab.openRun([
      docOf('A', [src('s'), task('t'), task('after')], [edgeOf('s', 't'), edgeOf('t', 'after')]),
    ]);
    lab.handlers.set('t', () => result);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'partial' });
    expect(status(workspace, 't')).toBe('failed');
    expect(workspace.getRuntime().states.get('t')?.message).toBeTruthy();
    expect(status(workspace, 'after')).toBe('skipped');
    expect(lab.calls).not.toContain('after');
  });

  it('缺少必需输入的节点失败且不执行，独立完整分支继续并整体为 partial', async () => {
    const workspace = lab.openRun([
      docOf('A', [src('s'), task('good'), task('lonely')], [edgeOf('s', 'good')]),
    ]);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'partial' });
    expect(status(workspace, 'good')).toBe('succeeded');
    expect(status(workspace, 'lonely')).toBe('failed');
    expect(lab.calls).not.toContain('lonely');
  });

  it('未连接的可选输入不会出现在 inputs 中', async () => {
    const workspace = lab.openRun([docOf('A', [src('s'), nodeOf('o', 'opt')], [edgeOf('s', 'o')])]);
    let keys: string[] = [];
    lab.handlers.set('o', ({ inputs }) => {
      keys = Object.keys(inputs);
      return { out: 'ok' };
    });
    await workspace.run();
    expect(keys).toEqual(['in']);
  });

  it('执行器抛出（含非 Error）都转换为节点失败，不让 run 拒绝', async () => {
    const workspace = lab.openRun([docOf('A', [src('a'), src('b')])]);
    const reason = randomUUID();
    lab.handlers.set('a', () => {
      throw new Error(reason);
    });
    lab.handlers.set('b', () => Promise.reject(reason));
    await expect(workspace.run()).resolves.toMatchObject({ status: 'failed' });
    const states = workspace.getRuntime().states;
    expect(states.get('a')).toMatchObject({ status: 'failed', message: reason });
    expect(states.get('b')?.status).toBe('failed');
    expect(states.get('b')?.message).toBeTruthy();
  });
});

/* ------------------------------ 特殊键与恶意内容 ------------------------------ */

describe('特殊键与恶意内容', () => {
  it('HTML 内容只作为数据原样保存、导出并传给执行器', async () => {
    const payload = '<img src=x onerror=alert(1)><script>window.pwned=1</script>';
    const source = { ...src('s', payload), name: payload };
    const workspace = lab.openRun([{ ...docOf('A', [source]), name: payload }]);
    const exported = JSON.parse(workspace.exportDocument()) as WorkflowDocument;
    expect(exported).toMatchObject({ name: payload });
    expect(exported.nodes[0]).toMatchObject({ name: payload, config: { value: payload } });
    await workspace.run();
    expect(workspace.getRuntime().states.get('s')?.outputs).toEqual({ out: payload });
  });

  it('导入配置中的 __proto__ 键只作为自有数据保留，不污染原型', async () => {
    const config = JSON.parse(
      '{"value":"v","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
    );
    const workspace = lab.open([docOf('A', [])]);
    const imported = workspace.importDocument(
      JSON.stringify(lab.withEntry(docOf('B', [nodeOf('s', 'src', config)]))),
    );
    const stored = imported.nodes[0].config;
    expect(Object.keys(stored)).toContain('__proto__');
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    let seen: Record<string, unknown> = {};
    lab.handlers.set('s', ({ node }) => {
      seen = node.config;
      return { out: 'v' };
    });
    await workspace.run();
    expect(Object.getPrototypeOf(seen)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('端口名与 Object.prototype 成员同名时仍按自有键传递', async () => {
    const workspace = lab.openRun([
      docOf(
        'A',
        [src('s', 'payload'), nodeOf('sp', 'special'), task('t')],
        [edgeOf('s', 'sp', 'constructor'), edgeOf('sp', 't', 'in', 'valueOf')],
      ),
    ]);
    let keys: string[] = [];
    lab.handlers.set('sp', ({ inputs }) => {
      keys = Object.keys(inputs);
      return { valueOf: String(inputs.constructor) };
    });
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(keys).toEqual(['constructor']);
    expect(workspace.getRuntime().states.get('t')?.outputs).toEqual({
      out: expect.stringContaining('payload'),
    });
  });

  it('执行器上下文只读：节点、输入和输出都已冻结，且传入 services 与取消信号', async () => {
    const workspace = lab.openRun([docOf('A', [src('s'), task('t')], [edgeOf('s', 't')])]);
    let context!: ExecuteContext;
    lab.handlers.set('t', (received) => {
      context = received;
      return { out: 'x' };
    });
    await workspace.run();
    expect(Object.isFrozen(context.inputs)).toBe(true);
    expect(Object.isFrozen(context.node)).toBe(true);
    expect(Object.isFrozen(context.node.config)).toBe(true);
    expect(context.services).toBe(lab.services);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(Object.isFrozen(workspace.getRuntime().states.get('t')?.outputs)).toBe(true);
  });

  it('输出被深拷贝冻结，执行器事后修改自己保留的引用不影响结果', async () => {
    const workspace = lab.openRun([docOf('A', [nodeOf('b', 'bag')])]);
    const shared = ['kept'];
    lab.handlers.set('b', () => ({ out: shared }));
    await workspace.run();
    shared.push('late');
    const outputs = workspace.getRuntime().states.get('b')?.outputs;
    expect(outputs?.out).toEqual(['kept']);
    expect(Object.isFrozen(outputs?.out)).toBe(true);
  });
});

/* ------------------------------ 存储边界 ------------------------------ */

describe('存储：结果只在内存，草稿保护', () => {
  it('运行结果不写入 localStorage 或导出，刷新后不恢复也不重跑', async () => {
    const workspace = lab.openRun([docOf('A', [src('s'), task('t')], [edgeOf('s', 't')])]);
    const marker = randomUUID();
    lab.handlers.set('t', () => ({ out: marker }));
    await workspace.run();
    workspace.setViewport({ x: 5, y: 6, zoom: 1.25 });
    const raw = lab.storage.data.get(STORAGE_KEY) ?? '';
    expect(raw).not.toContain(marker);
    expect(workspace.exportDocument()).not.toContain(marker);
    const stored = JSON.parse(raw).documents[0] as WorkflowDocument;
    expect(Object.keys(stored).sort()).toEqual([
      'edges',
      'id',
      'name',
      'nodes',
      'version',
      'viewport',
    ]);

    const callsBefore = lab.calls.length;
    const reopened = lab.reopen();
    expect(reopened.getRuntime().status).toBe('idle');
    expect(reopened.getRuntime().states.size).toBe(0);
    expect(reopened.getDocument().viewport).toEqual({ x: 5, y: 6, zoom: 1.25 });
    expect(lab.calls.length).toBe(callsBefore);
  });

  it('编辑、切换后的结构/配置/活动流程可从存储恢复', () => {
    const workspace = lab.open([docOf('A', [src('s')]), docOf('B', [])]);
    workspace.updateNode('s', { config: { value: 'edited' } });
    workspace.select('B');
    const reopened = lab.reopen();
    expect(reopened.activeId).toBe('B');
    expect(reopened.getDocument('A').nodes[0].config).toEqual({ value: 'edited' });
  });

  it('只有手动运行才会调用执行器：构建、编辑、撤销、切换都不触发', () => {
    const workspace = lab.open([docOf('A', [src('s'), task('t')]), docOf('B', [])]);
    workspace.connect(conn('s', 'out', 't', 'in'));
    workspace.updateNode('s', { config: { value: 'x' } });
    workspace.undo();
    workspace.select('B');
    lab.reopen();
    expect(lab.calls).toEqual([]);
  });

  const corrupt: Array<[string, () => string]> = [
    ['不是 JSON', () => '{not json'],
    ['格式版本不兼容', () => JSON.stringify({ version: 2, documents: [docOf('A', [])] })],
    ['没有任何流程', () => JSON.stringify({ version: 1, documents: [] })],
    [
      '其中一份流程无效',
      () => JSON.stringify({ version: 1, documents: [{ ...docOf('A', []), nodes: 'x' }] }),
    ],
    [
      '流程标识重复',
      () => JSON.stringify({ version: 1, documents: [docOf('A', []), docOf('A', [])] }),
    ],
    ['超过工作区体积上限', () => 'x'.repeat(LIMITS.workspaceBytes + 1)],
    [
      '视口缩放为 0',
      () =>
        JSON.stringify({
          version: 1,
          documents: [{ ...docOf('A', []), viewport: { x: 0, y: 0, zoom: 0 } }],
        }),
    ],
  ];

  it.each(corrupt)('草稿%s时进入保护模式：提示一次、编辑不覆盖原草稿', (_name, build) => {
    const raw = build();
    lab.storage.data.set(STORAGE_KEY, raw);
    const workspace = lab.reopen();
    expect(lab.errors).toHaveLength(1);
    expect(workspace.documents).toHaveLength(1);
    workspace.addNode('src', { x: 1, y: 1 });
    workspace.select(workspace.activeId);
    expect(lab.storage.data.get(STORAGE_KEY)).toBe(raw);
    expect(lab.storage.setItem).not.toHaveBeenCalled();
  });

  it.each<[string, (workspace: WorkspaceApi) => unknown]>([
    ['新建', (workspace) => workspace.create()],
    ['导入', (workspace) => workspace.importDocument(docOf('X', []))],
  ])('保护模式下显式%s后才允许替换草稿', (_name, operation) => {
    const raw = '{broken';
    lab.storage.data.set(STORAGE_KEY, raw);
    const workspace = lab.reopen();
    operation(workspace);
    const stored = lab.storage.data.get(STORAGE_KEY) ?? '';
    expect(stored).not.toBe(raw);
    expect(JSON.parse(stored).documents).toHaveLength(2);
  });

  it('读取存储抛错同样进入保护模式而不是让构造失败', () => {
    lab.storage.failReads = true;
    const workspace = lab.reopen();
    expect(workspace.documents).toHaveLength(1);
    expect(lab.errors).toHaveLength(1);
  });

  it('写入配额失败保留内存状态，只提示一次，恢复后重新保存并可再次提示', () => {
    const workspace = lab.open([docOf('A', [src('s')])]);
    lab.storage.failWrites = true;
    workspace.updateNode('s', { position: { x: 1, y: 1 } });
    workspace.updateNode('s', { position: { x: 2, y: 2 } });
    expect(workspace.getDocument().nodes[0].position).toEqual({ x: 2, y: 2 });
    expect(lab.errors).toHaveLength(1);

    lab.storage.failWrites = false;
    workspace.updateNode('s', { position: { x: 3, y: 3 } });
    expect(
      JSON.parse(lab.storage.data.get(STORAGE_KEY) ?? '').documents[0].nodes[0].position,
    ).toEqual({ x: 3, y: 3 });

    lab.storage.failWrites = true;
    workspace.updateNode('s', { position: { x: 4, y: 4 } });
    expect(lab.errors).toHaveLength(2);
  });
});

/* ------------------------------ 导入 ------------------------------ */

describe('导入', () => {
  it('未知节点类型与不支持的版本连同配置和连线一并保留，但整图不能运行', async () => {
    const ghost = nodeOf('g', 'ghost', { keep: { deep: [1, { x: 2 }] } });
    const future = nodeOf('f', 'versioned', { keep: true }, 9);
    const raw = lab.withEntry(
      docOf('X', [src('s'), ghost, future], [edgeOf('s', 'g'), edgeOf('s', 'f')]),
    );
    const workspace = lab.reopen();
    const imported = workspace.importDocument(JSON.stringify(raw));
    expect(imported.nodes).toEqual(raw.nodes);
    expect(imported.edges).toEqual(raw.edges);
    expect(JSON.parse(workspace.exportDocument()).nodes).toEqual(raw.nodes);
    expect(lab.registry.get('versioned', 9)).toBeUndefined();

    await expect(workspace.run()).rejects.toThrow(Error);
    expect(lab.calls).toEqual([]);
    expect(workspace.getRuntime().status).toBe('idle');
    expect(workspace.canUndo()).toBe(false);
  });

  it('已知版本的无效配置被拒绝，同样内容在未知类型下按数据保留', () => {
    const workspace = lab.reopen();
    expect(() => workspace.importDocument(docOf('X', [nodeOf('s', 'src', { value: 1 })]))).toThrow(
      Error,
    );
    expect(() =>
      workspace.importDocument(docOf('X', [nodeOf('s', 'unknown', { value: 1 })])),
    ).not.toThrow(Error);
  });

  it('导入总是生成新标识，不覆盖同标识流程，也不继承历史', () => {
    const workspace = lab.open([docOf('A', [src('s')])]);
    const imported = workspace.importDocument(workspace.exportDocument('A'));
    expect(imported.id).not.toBe('A');
    expect(workspace.documents.map((item) => item.id)).toContain('A');
    expect(workspace.activeId).toBe(imported.id);
    expect(workspace.canUndo()).toBe(false);
  });

  it('视口缩放无下限：任意有限正数可校验、保存恢复、导出导入，非正数被原子拒绝', () => {
    for (const zoom of [0.1, 0.01, 1e-8, LIMITS.maxZoom]) {
      const viewport = { x: 0, y: 0, zoom };
      expect(parseDocument({ ...docOf('X', []), viewport }, lab.registry).viewport).toEqual(
        viewport,
      );
    }
    const workspace = lab.open([docOf('A', [src('s')])]);
    workspace.setViewport({ x: 1, y: 2, zoom: 1e-8 });
    expect(lab.reopen().getDocument().viewport.zoom).toBe(1e-8);
    expect(JSON.parse(workspace.exportDocument()).viewport.zoom).toBe(1e-8);
    expect(workspace.importDocument(workspace.exportDocument()).viewport.zoom).toBe(1e-8);

    const before = lab.snapshot(workspace);
    for (const zoom of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, LIMITS.maxZoom + 0.01]) {
      expect(() => workspace.setViewport({ x: 0, y: 0, zoom })).toThrow(Error);
    }
    expect(lab.snapshot(workspace)).toEqual(before);
  });

  const tooMany = (count: number): WorkflowNode[] =>
    Array.from({ length: count }, (_, i) => src(`n${i}`));
  const rejected: Array<[string, () => unknown]> = [
    ['不是 JSON', () => '{'],
    ['格式版本不支持', () => ({ ...docOf('X', []), version: 2 })],
    ['空白名称', () => ({ ...docOf('X', []), name: '   ' })],
    ['节点数超限', () => docOf('X', tooMany(LIMITS.nodes + 1))],
    [
      '连线数超限',
      () =>
        docOf(
          'X',
          [src('s'), task('t')],
          Array.from({ length: LIMITS.edges + 1 }, (_, i) => edgeOf('s', 't', `p${i}`)),
        ),
    ],
    ['节点标识重复', () => docOf('X', [src('s'), src('s')])],
    [
      '节点坐标越界',
      () => docOf('X', [{ ...src('s'), position: { x: LIMITS.coordinate + 1, y: 0 } }]),
    ],
    [
      '节点尺寸过小',
      () => docOf('X', [{ ...src('s'), size: { width: LIMITS.minSize - 1, height: 200 } }]),
    ],
    [
      '节点尺寸过大',
      () => docOf('X', [{ ...src('s'), size: { width: 200, height: LIMITS.maxSize + 1 } }]),
    ],
    ['缩放越界', () => ({ ...docOf('X', []), viewport: { x: 0, y: 0, zoom: LIMITS.maxZoom + 1 } })],
    ...[0, -0.5, Number.NaN, Number.POSITIVE_INFINITY].map((zoom): [string, () => unknown] => [
      `缩放为 ${zoom}`,
      () => ({ ...docOf('X', []), viewport: { x: 0, y: 0, zoom } }),
    ]),
    ['配置嵌套过深', () => docOf('X', [nodeOf('g', 'ghost', nested(LIMITS.configDepth + 1))])],
    [
      '配置含超出范围的数值',
      () =>
        JSON.stringify(docOf('X', [nodeOf('g', 'ghost', { n: 0 })])).replace('"n":0', '"n":1e999'),
    ],
    ['存在环路', () => docOf('X', [task('x'), task('y')], [edgeOf('x', 'y'), edgeOf('y', 'x')])],
    ['数据类型不兼容的边', () => docOf('X', [nodeOf('n', 'num'), task('t')], [edgeOf('n', 't')])],
    [
      '单输入多源',
      () => docOf('X', [src('a'), src('b'), task('t')], [edgeOf('a', 't'), edgeOf('b', 't')]),
    ],
    ['边引用不存在的节点', () => docOf('X', [src('s')], [edgeOf('s', 'missing')])],
    ['文件超过 4 MiB', () => ' '.repeat(LIMITS.documentBytes + 1)],
    [
      '内容超过 4 MiB',
      () =>
        docOf(
          'X',
          Array.from({ length: LIMITS.nodes }, (_, i) =>
            nodeOf(`g${i}`, 'ghost', { blob: 'a'.repeat(50_000) }),
          ),
        ),
    ],
  ];

  it.each(rejected)('拒绝%s，且不改变文档、历史、存储和事件', (_name, build) => {
    const workspace = lab.open([docOf('A', [src('s')])]);
    workspace.updateNode('s', { position: { x: 1, y: 1 } });
    const before = lab.snapshot(workspace);
    expect(() => workspace.importDocument(build())).toThrow(Error);
    expect(lab.snapshot(workspace)).toEqual(before);
  });

  it('限额边界上的文档仍被接受', () => {
    const nodes = tooMany(LIMITS.nodes);
    nodes[0] = {
      ...nodes[0],
      position: { x: LIMITS.coordinate, y: -LIMITS.coordinate },
      size: { width: LIMITS.minSize, height: LIMITS.maxSize },
    };
    nodes[1] = nodeOf('deep', 'ghost', nested(LIMITS.configDepth));
    for (const zoom of [1e-8, LIMITS.maxZoom]) {
      const document = { ...docOf('X', nodes), viewport: { x: 0, y: 0, zoom } };
      expect(() => parseDocument(document, lab.registry)).not.toThrow(Error);
    }
  });
});

/* ------------------------------ 历史 ------------------------------ */

describe('历史', () => {
  const ghostBlob = (id: string): WorkflowNode =>
    nodeOf(id, 'ghost', { blob: 'a'.repeat(400_000) });

  it('多个流程拥有独立历史，可按 documentId 编辑非活动流程', () => {
    const workspace = lab.open([docOf('A', [src('sa')]), docOf('B', [src('sb')])]);
    workspace.updateNode('sb', { position: { x: 9, y: 9 } }, 'B');
    expect(workspace.canUndo('A')).toBe(false);
    expect(workspace.canUndo('B')).toBe(true);
    workspace.updateNode('sa', { position: { x: 3, y: 3 } }, 'A');
    workspace.undo('A');
    expect(workspace.getDocument('A').nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(workspace.getDocument('B').nodes[0].position).toEqual({ x: 9, y: 9 });
    expect(workspace.canUndo('B')).toBe(true);
  });

  describe('文本连续输入合并', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000);
    });

    it('窗口内的连续输入合并为一次撤销，重做回到最终文本', () => {
      const workspace = lab.open([docOf('A', [src('s', 'origin')])]);
      for (const value of ['a', 'ab', 'abc']) workspace.updateNode('s', { config: { value } });
      workspace.undo();
      expect(workspace.getDocument().nodes[0].config).toEqual({ value: 'origin' });
      expect(workspace.canUndo()).toBe(false);
      workspace.redo();
      expect(workspace.getDocument().nodes[0].config).toEqual({ value: 'abc' });
    });

    it('超过合并窗口后形成新的撤销步骤', () => {
      const workspace = lab.open([docOf('A', [src('s', 'origin')])]);
      workspace.updateNode('s', { config: { value: 'a' } });
      vi.setSystemTime(1_000_000 + LIMITS.inputMergeMs + 1);
      workspace.updateNode('s', { config: { value: 'ab' } });
      workspace.undo();
      expect(workspace.getDocument().nodes[0].config).toEqual({ value: 'a' });
      workspace.undo();
      expect(workspace.getDocument().nodes[0].config).toEqual({ value: 'origin' });
    });

    it('不同节点的输入、以及中间穿插的布局变更都不会被合并', () => {
      const workspace = lab.open([docOf('A', [src('s1', 'o1'), src('s2', 'o2')])]);
      workspace.updateNode('s1', { config: { value: 'x' } });
      workspace.updateNode('s2', { config: { value: 'y' } });
      workspace.updateNode('s2', { position: { x: 5, y: 5 } });
      workspace.updateNode('s2', { config: { value: 'z' } });
      let steps = 0;
      while (workspace.canUndo()) {
        workspace.undo();
        steps += 1;
      }
      expect(steps).toBe(4);
    });
  });

  it('撤销与重做不回滚视口，新的编辑清空重做栈', () => {
    const workspace = lab.open([docOf('A', [src('s')])]);
    workspace.updateNode('s', { position: { x: 7, y: 7 } });
    workspace.setViewport({ x: 11, y: 12, zoom: 1.5 });
    workspace.undo();
    expect(workspace.getDocument().viewport).toEqual({ x: 11, y: 12, zoom: 1.5 });
    expect(workspace.canRedo()).toBe(true);
    workspace.updateNode('s', { position: { x: 8, y: 8 } });
    expect(workspace.canRedo()).toBe(false);
  });

  it('每份流程最多保留 historySteps 步', () => {
    const workspace = lab.open([docOf('A', [src('s')])]);
    for (let i = 1; i <= LIMITS.historySteps + 10; i += 1)
      workspace.updateNode('s', { position: { x: i, y: i } });
    let steps = 0;
    while (workspace.canUndo()) {
      workspace.undo();
      steps += 1;
    }
    expect(steps).toBe(LIMITS.historySteps);
  });

  it('撤销数据总量受字节预算限制，大文档保留的步数少于步数上限', () => {
    const workspace = lab.open([docOf('A', [ghostBlob('big')])]);
    const documentBytes = Buffer.byteLength(JSON.stringify(workspace.getDocument()));
    for (let i = 1; i <= LIMITS.historySteps; i += 1)
      workspace.updateNode('big', { position: { x: i, y: i } });
    let steps = 0;
    while (workspace.canUndo()) {
      workspace.undo();
      steps += 1;
    }
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(LIMITS.historySteps);
    expect(steps * documentBytes).toBeLessThanOrEqual(LIMITS.historyBytes + steps * 64);
  });
});

/* ------------------------------ 流程管理与子图 ------------------------------ */

describe('流程管理与子图复制', () => {
  const chain = (): WorkflowDocument =>
    docOf('A', [src('a'), task('b'), task('c'), task('d')], [edgeOf('a', 'b'), edgeOf('b', 'c')]);

  it('复制子图重建标识与内部连线，不带出到选区外的连线，且是一次撤销', () => {
    const workspace = lab.open([chain()]);
    const copies = workspace.copySelection(['a', 'b']);
    const document = workspace.getDocument();
    expect(copies).toHaveLength(2);
    expect(document.nodes).toHaveLength(6);
    const originalIds = new Set(['a', 'b', 'c', 'd']);
    expect(copies.every((node) => !originalIds.has(node.id))).toBe(true);
    expect(new Set(document.nodes.map((node) => node.id)).size).toBe(6);

    const [copyA, copyB] = copies;
    const added = document.edges.filter((edge) => !['a-b-in', 'b-c-in'].includes(edge.id));
    expect(added).toHaveLength(1);
    expect(added[0].source).toEqual({ nodeId: copyA.id, port: 'out' });
    expect(added[0].target).toEqual({ nodeId: copyB.id, port: 'in' });
    expect(document.edges).toHaveLength(3);
    expect(copyA.position).not.toEqual(document.nodes[0].position);

    workspace.undo();
    expect(workspace.getDocument().nodes).toHaveLength(4);
    expect(workspace.getDocument().edges).toHaveLength(2);
  });

  it('复制超出节点上限时整体失败，文档保持不变', () => {
    const nodes = Array.from({ length: LIMITS.nodes / 2 + 1 }, (_, i) => src(`n${i}`));
    const workspace = lab.open([docOf('A', nodes)]);
    const before = lab.snapshot(workspace);
    expect(() => workspace.copySelection(nodes.map((node) => node.id))).toThrow(Error);
    expect(lab.snapshot(workspace)).toEqual(before);
  });

  it('删除节点同时清理关联连线，删除连线不影响节点', () => {
    const workspace = lab.open([chain()]);
    workspace.deleteSelection({ nodeIds: ['b'] });
    expect(workspace.getDocument().edges).toEqual([]);
    workspace.undo();
    workspace.deleteSelection({ edgeIds: ['a-b-in'] });
    expect(workspace.getDocument().nodes).toHaveLength(4);
    expect(workspace.getDocument().edges.map((edge) => edge.id)).toEqual(['b-c-in']);
  });

  it('复制流程得到独立副本：新标识、相同结构、无历史无结果，原流程不变', async () => {
    const workspace = lab.openRun([chain()]);
    await workspace.run();
    const original = workspace.getDocument('A');
    const copy = workspace.duplicate('A');
    expect(copy.id).not.toBe('A');
    expect(copy.nodes).toEqual(original.nodes);
    expect(copy.edges).toEqual(original.edges);
    expect(workspace.activeId).toBe(copy.id);
    expect(workspace.canUndo(copy.id)).toBe(false);
    expect(workspace.getRuntime(copy.id).states.size).toBe(0);
    expect(workspace.getDocument('A')).toBe(original);
  });

  it('删除活动流程后切换到剩余流程；删除最后一个会留下新的空流程', () => {
    const workspace = lab.open([docOf('A', [src('s')]), docOf('B', [])]);
    workspace.remove('A');
    expect(workspace.activeId).toBe('B');
    expect(() => workspace.getDocument('A')).toThrow(Error);
    workspace.remove('B');
    expect(workspace.documents).toHaveLength(1);
    expect(workspace.activeId).not.toBe('B');
    expect(workspace.getDocument().nodes).toEqual([]);
  });

  it('流程数量与工作区累计体积受限，超限不安装新流程', () => {
    const workspace = lab.reopen();
    while (workspace.documents.length < LIMITS.documents) workspace.create();
    expect(() => workspace.create()).toThrow(Error);
    expect(workspace.documents).toHaveLength(LIMITS.documents);

    lab.storage = new MemoryStorage();
    const bulky = lab.reopen();
    const blob = (): WorkflowDocument =>
      docOf('X', [nodeOf('g', 'ghost', { blob: 'a'.repeat(3 * 1024 * 1024) })]);
    bulky.importDocument(blob());
    bulky.importDocument(blob());
    const before = lab.snapshot(bulky);
    expect(() => bulky.importDocument(blob())).toThrow(Error);
    expect(lab.snapshot(bulky)).toEqual(before);
  });

  it('导入默认追加“副本”；preserveName 保留原名，但仍新标识、清本地配置、无历史与结果', () => {
    lab.registry.register({
      type: 'secret',
      version: 1,
      label: 'secret',
      category: 'test',
      execution: 'data',
      inputs: [],
      outputs: [text('out')],
      defaults: { token: '' },
      localConfig: true,
      execute: ({ node }) => ({ out: String(node.config.token) }),
    });
    const raw = JSON.stringify({
      ...docOf('X', [nodeOf('k', 'secret', { token: 'abc' }), src('s')]),
      name: '周报',
    });
    const workspace = lab.open([docOf('A', [src('a')])]);
    workspace.updateNode('a', { position: { x: 1, y: 1 } });

    const copied = workspace.importDocument(raw);
    const kept = workspace.importDocument(raw, { preserveName: true });
    expect(copied.name).toBe('周报 副本');
    expect(kept.name).toBe('周报');
    expect(new Set(['X', 'A', copied.id, kept.id]).size).toBe(4);
    expect(kept.nodes.find((node) => node.id === 'k')?.config).toEqual({ token: '' });
    expect(workspace.activeId).toBe(kept.id);
    expect(workspace.canUndo(kept.id)).toBe(false);
    expect(workspace.getRuntime(kept.id).states.size).toBe(0);
    expect(workspace.getDocument('A').name).toBe('A');
    expect(lab.reopen().getDocument(kept.id).name).toBe('周报');
  });

  it('preserveName 导入保持原子：无效内容或超出体积预算时不改变工作区', () => {
    const workspace = lab.open([docOf('A', [src('s')])]);
    const before = lab.snapshot(workspace);
    expect(() => workspace.importDocument('{bad', { preserveName: true })).toThrow(Error);
    expect(() =>
      workspace.importDocument(docOf('X', [nodeOf('s', 'src', { value: 1 })]), {
        preserveName: true,
      }),
    ).toThrow(Error);
    expect(lab.snapshot(workspace)).toEqual(before);

    lab.storage = new MemoryStorage();
    const bulky = lab.reopen();
    const blob = (): WorkflowDocument =>
      docOf('X', [nodeOf('g', 'ghost', { blob: 'a'.repeat(3 * 1024 * 1024) })]);
    bulky.importDocument(blob(), { preserveName: true });
    bulky.importDocument(blob(), { preserveName: true });
    const full = lab.snapshot(bulky);
    expect(() => bulky.importDocument(blob(), { preserveName: true })).toThrow(Error);
    expect(lab.snapshot(bulky)).toEqual(full);
  });
});

/* ------------------------------ 运行锁 ------------------------------ */

describe('运行锁', () => {
  const setup = async (): Promise<{
    workspace: WorkspaceApi;
    finished: Promise<unknown>;
    gate: Deferred;
  }> => {
    const workspace = lab.openRun([
      docOf('A', [src('s'), task('t'), task('u')], [edgeOf('s', 't')]),
      docOf('B', [src('b')]),
    ]);
    workspace.updateNode('t', { position: { x: 1, y: 1 } });
    workspace.updateNode('t', { position: { x: 2, y: 2 } });
    workspace.undo();
    const gate = lab.gate('s');
    const finished = workspace.run();
    await vi.waitFor(() => expect(lab.calls).toContain('s'));
    return { workspace, finished, gate };
  };

  const locked: Array<[string, (workspace: WorkspaceApi) => unknown]> = [
    ['updateNode', (w) => w.updateNode('t', { position: { x: 5, y: 5 } })],
    ['改节点配置', (w) => w.updateNode('s', { config: { value: 'x' } })],
    ['addNode', (w) => w.addNode('src', { x: 0, y: 0 })],
    ['connect', (w) => w.connect(conn('s', 'out', 'u', 'in'))],
    ['disconnect', (w) => w.disconnect('s-t-in')],
    ['deleteSelection', (w) => w.deleteSelection({ nodeIds: ['t'] })],
    ['copySelection', (w) => w.copySelection(['s'])],
    ['insertSubgraph', (w) => w.insertSubgraph({ nodes: [src('x')], edges: [] })],
    ['updateLayout', (w) => w.updateLayout([{ id: 't', position: { x: 5, y: 5 } }])],
    ['rename', (w) => w.rename('A', 'renamed')],
    ['duplicate', (w) => w.duplicate('A')],
    ['remove', (w) => w.remove('A')],
    ['undo', (w) => w.undo()],
    ['redo', (w) => w.redo()],
  ];

  it.each(locked)('运行中拒绝 %s，不改变任何状态', async (_name, operation) => {
    const { workspace, finished } = await setup();
    const before = lab.snapshot(workspace);
    expect(() => operation(workspace)).toThrow(Error);
    expect(lab.snapshot(workspace)).toEqual(before);
    workspace.stop();
    await finished;
  });

  it('运行中拒绝重复运行，且撤销/重做不可用', async () => {
    const { workspace, finished } = await setup();
    await expect(workspace.run()).rejects.toThrow(Error);
    expect(workspace.canUndo()).toBe(false);
    expect(workspace.canRedo()).toBe(false);
    workspace.stop();
    await finished;
    expect(workspace.canUndo()).toBe(true);
  });

  it('运行中仍可调整视口、切换/新建流程并编辑其他流程，且不影响该次运行', async () => {
    const { workspace, finished, gate } = await setup();
    workspace.setViewport({ x: 3, y: 4, zoom: 1.5 }, 'A');
    workspace.select('B');
    workspace.updateNode('b', { config: { value: 'changed' } });
    workspace.create();
    expect(workspace.getRuntime('A').running).toBe(true);
    expect(workspace.getDocument('A').viewport).toEqual({ x: 3, y: 4, zoom: 1.5 });
    gate.resolve({ out: 'done' });
    await expect(finished).resolves.toMatchObject({ status: 'partial' });
  });

  it('运行结束后立即解锁', async () => {
    const { workspace, finished, gate } = await setup();
    gate.resolve({ out: 'done' });
    await finished;
    expect(() => workspace.updateNode('t', { position: { x: 9, y: 9 } })).not.toThrow(Error);
  });
});

/* ------------------------------ 调度 ------------------------------ */

describe('调度', () => {
  it('分支失败只阻断其下游，汇合节点被跳过，独立分支继续，整体 partial', async () => {
    const workspace = lab.openRun([
      docOf(
        'A',
        [src('s'), task('bad'), task('good'), nodeOf('j', 'join'), src('s2'), task('free')],
        [
          edgeOf('s', 'bad'),
          edgeOf('s', 'good'),
          edgeOf('bad', 'j', 'a'),
          edgeOf('good', 'j', 'b'),
          edgeOf('s2', 'free'),
        ],
      ),
    ]);
    lab.handlers.set('bad', () => {
      throw new Error('boom');
    });
    await expect(workspace.run()).resolves.toMatchObject({ status: 'partial' });
    expect(status(workspace, 'bad')).toBe('failed');
    expect(status(workspace, 'j')).toBe('skipped');
    expect(workspace.getRuntime().states.get('j')?.outputs).toBeNull();
    expect(status(workspace, 'good')).toBe('succeeded');
    expect(status(workspace, 'free')).toBe('succeeded');
    expect(lab.calls).not.toContain('j');
  });

  it('汇合节点在所有上游成功后收到两路输入，分发的同一输出对各下游一致', async () => {
    const workspace = lab.openRun([
      docOf(
        'A',
        [src('s', 'shared'), task('left'), task('right'), nodeOf('j', 'join')],
        [
          edgeOf('s', 'left'),
          edgeOf('s', 'right'),
          edgeOf('left', 'j', 'a'),
          edgeOf('right', 'j', 'b'),
        ],
      ),
    ]);
    const seen: Record<string, unknown>[] = [];
    lab.handlers.set('left', ({ inputs }) => (seen.push(inputs), { out: 'L' }));
    lab.handlers.set('right', ({ inputs }) => (seen.push(inputs), { out: 'R' }));
    let joined: Record<string, unknown> = {};
    lab.handlers.set('j', ({ inputs }) => ((joined = inputs), { out: 'done' }));
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(seen).toHaveLength(2);
    expect(seen[0].in).toBe('shared');
    expect(seen[1].in).toBe('shared');
    expect({ ...joined }).toEqual({ a: 'L', b: 'R' });
  });

  it('上游源任务成功而下游任务失败时整体为 partial，不被成功的上游掩盖', async () => {
    const workspace = lab.openRun([docOf('A', [src('s'), task('t')], [edgeOf('s', 't')])]);
    lab.handlers.set('t', () => ({}));
    await expect(workspace.run()).resolves.toMatchObject({ status: 'partial' });
    expect(status(workspace, 's')).toBe('succeeded');
    expect(status(workspace, 't')).toBe('failed');
  });

  it('没有节点时拒绝运行；含未知节点时在执行任何节点前拒绝', async () => {
    const empty = lab.open([docOf('A', [])]);
    await expect(empty.run()).rejects.toThrow(Error);
    const mixed = lab.openRun([docOf('B', [src('s'), nodeOf('g', 'ghost')])]);
    await expect(mixed.run()).rejects.toThrow(Error);
    expect(lab.calls).toEqual([]);
    expect(mixed.getRuntime().running).toBe(false);
  });

  it('已就绪的下游不等待无关的慢分支', async () => {
    const workspace = lab.openRun([
      docOf(
        'A',
        [src('s1'), task('fast'), task('fastDown'), src('s2'), task('slow')],
        [edgeOf('s1', 'fast'), edgeOf('fast', 'fastDown'), edgeOf('s2', 'slow')],
      ),
    ]);
    const gate = lab.gate('slow');
    const finished = workspace.run();
    await vi.waitFor(() => expect(status(workspace, 'fastDown')).toBe('succeeded'));
    expect(status(workspace, 'slow')).toBe('running');
    expect(workspace.getRuntime().running).toBe(true);
    gate.resolve({ out: 'x' });
    await expect(finished).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('多个流程共享有界并发，排队节点显示 queued', async () => {
    const ids = ['D0', 'D1', 'D2'];
    const documents = ids.map((id) =>
      docOf(
        id,
        Array.from({ length: 4 }, (_, i) => src(`${id}n${i}`)),
      ),
    );
    const workspace = lab.openRun(documents);
    let active = 0;
    let peak = 0;
    const gates = new Map<string, Deferred>();
    for (const node of documents.flatMap((document) => document.nodes)) {
      lab.handlers.set(node.id, async () => {
        active += 1;
        peak = Math.max(peak, active);
        const gate = deferred();
        gates.set(node.id, gate);
        await gate.promise;
        active -= 1;
        return { out: node.id };
      });
    }
    const runs = ids.map((id) => workspace.run(id));
    await vi.waitFor(() => expect(active).toBe(LIMITS.concurrency));
    await tick();
    await tick();
    expect(active).toBe(LIMITS.concurrency);
    const total = ids.length * 4;
    const queued = ids
      .flatMap((id) => [...workspace.getRuntime(id).states.values()])
      .filter((state) => state.status === 'queued');
    expect(queued).toHaveLength(total - LIMITS.concurrency);

    let done = false;
    void Promise.all(runs).then(() => {
      done = true;
    });
    while (!done) {
      gates.forEach((gate) => gate.resolve(undefined));
      await tick();
    }
    expect(peak).toBe(LIMITS.concurrency);
    for (const id of ids) expect(workspace.getRuntime(id).status).toBe('succeeded');
  });

  it('同时运行的流程状态互相独立；切换流程不会取消运行', async () => {
    const workspace = lab.openRun([docOf('A', [src('a')]), docOf('B', [src('b')])]);
    const gate = lab.gate('a');
    const runA = workspace.run('A');
    await vi.waitFor(() => expect(lab.calls).toContain('a'));
    workspace.select('B');
    workspace.create();
    await expect(workspace.run('B')).resolves.toMatchObject({ status: 'succeeded' });
    expect(workspace.getRuntime('A').running).toBe(true);
    expect(workspace.getRuntime('A').states.get('a')?.status).toBe('running');
    gate.resolve({ out: 'late' });
    await expect(runA).resolves.toMatchObject({ status: 'succeeded' });
  });
});

/* ------------------------------ 停止与迟到结果 ------------------------------ */

describe('停止', () => {
  it('停止立即解锁并取消运行中/排队节点，取消信号传给执行器，run 以 cancelled 结束', async () => {
    const workspace = lab.openRun([docOf('A', [src('s'), task('t')], [edgeOf('s', 't')])]);
    let signal!: AbortSignal;
    lab.handlers.set('s', (context) => {
      signal = context.signal;
      return deferred().promise;
    });
    const finished = workspace.run();
    await vi.waitFor(() => expect(lab.calls).toContain('s'));
    workspace.stop();
    expect(signal.aborted).toBe(true);
    const runtime = workspace.getRuntime();
    expect(runtime).toMatchObject({ running: false, status: 'cancelled' });
    expect(status(workspace, 's')).toBe('cancelled');
    expect(status(workspace, 't')).toBe('cancelled');
    expect(() => workspace.updateNode('s', { position: { x: 2, y: 2 } })).not.toThrow(Error);
    await expect(finished).resolves.toMatchObject({ status: 'cancelled' });
    expect(lab.calls).not.toContain('t');
  });

  it('停止空闲流程是空操作', () => {
    const workspace = lab.open([docOf('A', [src('s')])]);
    expect(() => workspace.stop()).not.toThrow(Error);
    expect(workspace.getRuntime().status).toBe('idle');
  });

  it('停止后立即重跑：旧执行器忽略取消、迟到的结果不会覆盖新一次运行', async () => {
    const workspace = lab.openRun([docOf('A', [src('a')])]);
    const attempts: Array<{ gate: Deferred; signal: AbortSignal }> = [];
    lab.handlers.set('a', ({ signal }) => {
      const gate = deferred();
      attempts.push({ gate, signal });
      return gate.promise;
    });
    const first = workspace.run();
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    workspace.stop();
    const second = workspace.run();
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[0].signal.aborted).toBe(true);
    expect(attempts[1].signal.aborted).toBe(false);

    attempts[0].gate.resolve({ out: 'old' });
    await tick();
    expect(status(workspace, 'a')).toBe('running');
    attempts[1].gate.resolve({ out: 'new' });
    await expect(second).resolves.toMatchObject({ status: 'succeeded' });
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    await tick();
    expect(workspace.getRuntime().states.get('a')?.outputs).toEqual({ out: 'new' });
    expect(workspace.getRuntime().status).toBe('succeeded');
  });

  it('停止后排队节点不再启动；忽略取消的旧执行器占着名额，直到真正结束后新队列才启动', async () => {
    const stuck = Array.from({ length: LIMITS.concurrency + 2 }, (_, i) => src(`a${i}`));
    const workspace = lab.openRun([docOf('A', stuck), docOf('B', [src('b')])]);
    const gates = new Map<string, Deferred>();
    for (const node of stuck) {
      const gate = deferred();
      gates.set(node.id, gate);
      lab.handlers.set(node.id, () => gate.promise);
    }
    const finished = workspace.run('A');
    await vi.waitFor(() => expect(lab.calls).toHaveLength(LIMITS.concurrency));
    const states = [...workspace.getRuntime('A').states.values()].map((state) => state.status);
    expect(states.filter((value) => value === 'running')).toHaveLength(LIMITS.concurrency);
    expect(states.filter((value) => value === 'queued')).toHaveLength(2);

    workspace.stop('A');
    await finished;
    const next = workspace.run('B');
    await tick();
    await tick();
    expect(status(workspace, ENTRY_ID, 'B')).toBe('queued'); // 入口也占用共享并发，因此被旧执行器挡在队列中
    expect(status(workspace, 'b', 'B')).toBe('queued');
    expect(lab.calls).not.toContain('b');

    gates.get('a0')?.resolve({ out: 'late' });
    await expect(next).resolves.toMatchObject({ status: 'succeeded' });
    expect(lab.calls.filter((id) => id.startsWith('a'))).toHaveLength(LIMITS.concurrency);
    gates.forEach((gate) => gate.resolve({ out: 'late' }));
  });

  it('反复停止并重跑忽略取消的执行器，实际并发不会超过上限', async () => {
    const workspace = lab.openRun([docOf('A', [src('a')])]);
    const gates: Deferred[] = [];
    let active = 0;
    let peak = 0;
    lab.handlers.set('a', async () => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active -= 1;
      return { out: 'x' };
    });
    for (let i = 0; i < LIMITS.concurrency + 3; i += 1) {
      const run = workspace.run();
      await tick();
      await tick();
      workspace.stop();
      await run;
    }
    expect(peak).toBe(LIMITS.concurrency);
    expect(gates).toHaveLength(LIMITS.concurrency);

    const fresh = workspace.run();
    await tick();
    expect(gates).toHaveLength(LIMITS.concurrency);
    gates[0].resolve(undefined);
    await vi.waitFor(() => expect(gates).toHaveLength(LIMITS.concurrency + 1));
    gates.forEach((gate) => gate.resolve(undefined));
    await expect(fresh).resolves.toMatchObject({ status: 'succeeded' });
    expect(peak).toBe(LIMITS.concurrency);
  });

  it('停止某个流程不影响其他流程的运行', async () => {
    const workspace = lab.openRun([docOf('A', [src('a')]), docOf('B', [src('b')])]);
    const gateB = lab.gate('b');
    lab.gate('a');
    const runA = workspace.run('A');
    const runB = workspace.run('B');
    await vi.waitFor(() => expect(lab.calls).toHaveLength(2));
    workspace.stop('A');
    expect(workspace.getRuntime('B').running).toBe(true);
    gateB.resolve({ out: 'b' });
    await expect(runB).resolves.toMatchObject({ status: 'succeeded' });
    await expect(runA).resolves.toMatchObject({ status: 'cancelled' });
  });
});

/* ------------------------------ 结果内存预算 ------------------------------ */

describe('运行结果内存预算', () => {
  const bigValue = (index: number, tag = ''): string =>
    `${tag}${index}:${'汉'.repeat(LIMITS.textLength - 20)}`;
  const bigSources = (prefix: string, count: number): WorkflowNode[] => {
    const nodes = Array.from({ length: count }, (_, i) => src(`${prefix}${i}`));
    nodes.forEach((node, i) => lab.handlers.set(node.id, () => ({ out: bigValue(i, prefix) })));
    return nodes;
  };
  const perOutput = Buffer.byteLength(bigValue(0));

  it('单个流程累计输出超过预算时，超出的节点失败，已成功的结果保留且总量不超限', async () => {
    const count = Math.ceil(LIMITS.resultBytes / perOutput) + 3;
    const workspace = lab.openRun([docOf('A', bigSources('n', count))]);
    const result = await workspace.run();
    const states = [...workspace.getRuntime().states]
      .filter(([id]) => id !== ENTRY_ID)
      .map(([, state]) => state); // 入口不产生业务输出，不计预算
    const succeeded = states.filter((state) => state.status === 'succeeded');
    const failed = states.filter((state) => state.status === 'failed');
    expect(result.status).toBe('partial');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((state) => state.message)).toBe(true);
    expect(succeeded.length * perOutput).toBeLessThanOrEqual(LIMITS.resultBytes);
  });

  it('其他流程的旧结果先被清理以腾出空间，并通知该流程', async () => {
    const count = Math.ceil((LIMITS.resultBytes * 0.6) / perOutput);
    const workspace = lab.openRun([
      docOf('A', bigSources('a', count)),
      docOf('B', bigSources('b', count)),
    ]);
    await workspace.run('A');
    expect(workspace.getRuntime('A').status).toBe('succeeded');
    await expect(workspace.run('B')).resolves.toMatchObject({ status: 'succeeded' });
    expect(workspace.getRuntime('A')).toMatchObject({ status: 'idle' });
    expect(workspace.getRuntime('A').states.size).toBe(0);
    expect(lab.events).toContainEqual(expect.objectContaining({ id: 'A', kind: 'runtime' }));
  });
});

describe('回归：预算与连线保护', () => {
  it('相同的大字符串在每个端口各计一次预算，不会因内容相同而被合并', async () => {
    const perOutput = Buffer.byteLength('汉'.repeat(LIMITS.textLength));
    const count = Math.ceil(LIMITS.resultBytes / perOutput) + 3;
    const nodes = Array.from({ length: count }, (_, i) => src(`n${i}`));
    const shared = '汉'.repeat(LIMITS.textLength);
    for (const node of nodes) lab.handlers.set(node.id, () => ({ out: shared }));
    const workspace = lab.openRun([docOf('A', nodes)]);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'partial' });
    const states = [...workspace.getRuntime().states]
      .filter(([id]) => id !== ENTRY_ID)
      .map(([, state]) => state);
    expect(states.some((state) => state.status === 'failed')).toBe(true);
    expect(
      states.filter((state) => state.status === 'succeeded').length * perOutput,
    ).toBeLessThanOrEqual(LIMITS.resultBytes);
  });

  it('connect 忽略调用方传入的 allowUnknown，不能连到未安装的节点', () => {
    const workspace = lab.open([docOf('A', [src('s'), nodeOf('g', 'ghost')])]);
    const before = lab.snapshot(workspace);
    expect(() => workspace.connect({ ...conn('s', 'out', 'g', 'in'), allowUnknown: true })).toThrow(
      Error,
    );
    expect(lab.snapshot(workspace)).toEqual(before);
  });

  it('connect 忽略调用方传入的边 id，不能借已有边的 id 绕过单输入限制', () => {
    const workspace = lab.open([docOf('A', [src('s'), src('s2'), task('t')], [edgeOf('s', 't')])]);
    const before = lab.snapshot(workspace);
    expect(() => workspace.connect({ id: 's-t-in', ...conn('s2', 'out', 't', 'in') })).toThrow(
      Error,
    );
    expect(lab.snapshot(workspace)).toEqual(before);
    expect(workspace.getDocument().edges).toHaveLength(1);
  });

  it('停止的流程残留的取消结果同样计入保留上限，最早的结果被清理并通知', async () => {
    const documents = Array.from({ length: LIMITS.resultDocuments + 1 }, (_, i) =>
      docOf(`D${i}`, [src(`n${i}`)]),
    );
    const workspace = lab.openRun(documents);
    const last = documents[documents.length - 1];
    for (const document of documents.slice(0, -1)) await workspace.run(document.id);
    lab.gate(last.nodes[0].id);
    const finished = workspace.run(last.id);
    await vi.waitFor(() => expect(lab.calls).toContain(last.nodes[0].id));
    lab.events.length = 0;
    workspace.stop(last.id);
    await finished;
    const withResults = documents.filter(
      (document) => workspace.getRuntime(document.id).states.size > 0,
    );
    expect(withResults).toHaveLength(LIMITS.resultDocuments);
    expect(workspace.getRuntime('D0').status).toBe('idle');
    expect(workspace.getRuntime(last.id).status).toBe('cancelled');
    expect(lab.events).toContainEqual({ id: 'D0', kind: 'runtime' });
  });
});

describe('回归：整个工作区预算与 withAbort', () => {
  const blobDocument = (id: string, size: number): WorkflowDocument =>
    docOf(id, [nodeOf('g', 'ghost', { blob: 'a'.repeat(size) })]);
  const seedAtLimit = (): WorkspaceApi => {
    const raw = (lastBlob: number): string =>
      JSON.stringify({
        version: 1,
        activeId: 'A',
        documents: [
          blobDocument('A', 3_000_000),
          blobDocument('LONGER_ID_B', 3_000_000),
          blobDocument('C', lastBlob),
        ],
      });
    const slack = LIMITS.workspaceBytes - Buffer.byteLength(raw(0));
    lab.storage.data.set(STORAGE_KEY, raw(slack));
    expect(Buffer.byteLength(lab.storage.data.get(STORAGE_KEY) ?? '')).toBe(LIMITS.workspaceBytes);
    const workspace = lab.reopen();
    expect(lab.errors).toEqual([]);
    return workspace;
  };

  it('视口变更会撑破完整工作区预算时被原子拒绝', () => {
    const workspace = seedAtLimit();
    const before = lab.snapshot(workspace);
    expect(() => workspace.setViewport({ x: 12345.6789, y: 0, zoom: 1 }, 'A')).toThrow(Error);
    expect(lab.snapshot(workspace)).toEqual(before);
  });

  it('切换流程时 activeId 也计入预算，超限则保持原活动流程', () => {
    const workspace = seedAtLimit();
    const before = lab.snapshot(workspace);
    expect(() => workspace.select('LONGER_ID_B')).toThrow(Error);
    expect(lab.snapshot(workspace)).toEqual(before);
    expect(workspace.activeId).toBe('A');
  });

  it('信号已取消时仍接管源 Promise，其后续拒绝不会成为未处理拒绝', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const controller = new AbortController();
      controller.abort();
      const guarded = withAbort(Promise.reject(new Error('source failed')), controller.signal);
      await expect(guarded).rejects.toMatchObject({ name: 'AbortError' });
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('批量编辑：insertSubgraph 与 updateLayout', () => {
  const template = (): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } => ({
    nodes: [src('t1'), task('t2')],
    edges: [edgeOf('t1', 't2')],
  });

  it('模板插入分配新标识并重建连线，一次撤销整体清空，重做恢复相同内容', () => {
    const workspace = lab.open([docOf('A', [src('existing')])]);
    const inserted = workspace.insertSubgraph(template());
    const document = workspace.getDocument();
    expect(inserted.map((node) => node.id)).not.toContain('t1');
    expect(document.nodes).toHaveLength(3);
    expect(document.edges).toHaveLength(1);
    expect(document.edges[0].source.nodeId).toBe(inserted[0].id);
    expect(document.edges[0].target.nodeId).toBe(inserted[1].id);

    const second = workspace.insertSubgraph(template());
    expect(new Set([...inserted, ...second].map((node) => node.id)).size).toBe(4);
    workspace.undo();
    workspace.undo();
    expect(workspace.getDocument().nodes.map((node) => node.id)).toEqual(['existing']);
    expect(workspace.getDocument().edges).toEqual([]);
    expect(workspace.canUndo()).toBe(false);
    workspace.redo();
    expect(workspace.getDocument().nodes.map((node) => node.id)).toEqual([
      'existing',
      ...inserted.map((node) => node.id),
    ]);
    expect(workspace.getDocument().edges).toHaveLength(1);
  });

  it('模板插入保留无关旧结果、标记过期并只发布一次 structure 事件', async () => {
    const workspace = lab.openRun([docOf('A', [src('existing')])]);
    await workspace.run();
    lab.events.length = 0;
    workspace.insertSubgraph(template());
    expect(workspace.getRuntime().states.size).toBe(2);
    expect(workspace.getRuntime().status).toBe('stale');
    expect(lab.events.filter((event) => event.kind === 'structure')).toHaveLength(1);
  });

  it.each<[string, () => { nodes: WorkflowNode[]; edges: WorkflowEdge[] }]>([
    ['未注册的节点类型', () => ({ nodes: [src('t1'), nodeOf('g', 'ghost')], edges: [] })],
    [
      '类型不兼容的连线',
      () => ({ nodes: [nodeOf('n', 'num'), task('t')], edges: [edgeOf('n', 't')] }),
    ],
    ['连线引用不存在的节点', () => ({ nodes: [src('t1')], edges: [edgeOf('t1', 'missing')] })],
    [
      '环路',
      () => ({ nodes: [task('x'), task('y')], edges: [edgeOf('x', 'y'), edgeOf('y', 'x')] }),
    ],
    ['已知节点配置无效', () => ({ nodes: [nodeOf('s', 'src', { value: 1 })], edges: [] })],
    [
      '超出节点上限',
      () => ({ nodes: Array.from({ length: LIMITS.nodes }, (_, i) => src(`n${i}`)), edges: [] }),
    ],
  ])('模板含%s时整体拒绝，不改变文档、历史和存储', (_name, build) => {
    const workspace = lab.open([docOf('A', [src('existing')])]);
    const before = lab.snapshot(workspace);
    expect(() => workspace.insertSubgraph(build())).toThrow(Error);
    expect(lab.snapshot(workspace)).toEqual(before);
  });

  const trio = (): WorkflowDocument =>
    docOf('A', [src('a'), task('b'), task('c')], [edgeOf('a', 'b')]);

  it('多节点拖动是一次历史：一次撤销全部还原，重做全部恢复，且保留运行结果', async () => {
    const workspace = lab.openRun([trio()]);
    await workspace.run();
    lab.events.length = 0;
    workspace.updateLayout([
      { id: 'a', position: { x: 10, y: 10 } },
      { id: 'b', position: { x: 20, y: 20 } },
      { id: 'c', size: { width: 320, height: 300 } },
    ]);
    expect(workspace.getRuntime().states.size).toBe(4);
    expect(lab.events).toEqual([{ id: 'A', kind: 'layout', nodeIds: ['a', 'b', 'c'] }]);

    workspace.undo();
    const restored = workspace.getDocument().nodes;
    expect(restored.map((node) => node.position)).toEqual(restored.map(() => ({ x: 0, y: 0 })));
    expect(restored[2].size).toEqual({ width: 200, height: 200 });
    expect(workspace.canUndo()).toBe(false);
    expect(workspace.getRuntime().states.size).toBe(4);
    workspace.redo();
    expect(workspace.getDocument().nodes[1].position).toEqual({ x: 20, y: 20 });
    expect(workspace.getDocument().nodes[2].size).toEqual({ width: 320, height: 300 });
  });

  it.each<[string, Parameters<WorkspaceApi['updateLayout']>[0]]>([
    [
      '其中一个节点不存在',
      [
        { id: 'a', position: { x: 10, y: 10 } },
        { id: 'missing', position: { x: 1, y: 1 } },
      ],
    ],
    [
      '其中一个坐标越界',
      [
        { id: 'a', position: { x: 10, y: 10 } },
        { id: 'b', position: { x: LIMITS.coordinate + 1, y: 0 } },
      ],
    ],
    [
      '其中一个尺寸越界',
      [
        { id: 'a', position: { x: 10, y: 10 } },
        { id: 'b', size: { width: LIMITS.maxSize + 1, height: 200 } },
      ],
    ],
  ])('批量布局%s时整体失败，已通过校验的节点也不会移动', (_name, updates) => {
    const workspace = lab.open([trio()]);
    const before = lab.snapshot(workspace);
    expect(() => workspace.updateLayout(updates)).toThrow(Error);
    expect(lab.snapshot(workspace)).toEqual(before);
  });

  it('没有实际变化的批量布局不产生历史和事件', () => {
    const workspace = lab.open([trio()]);
    workspace.updateLayout([{ id: 'a', position: { x: 0, y: 0 } }]);
    expect(workspace.canUndo()).toBe(false);
    expect(lab.events).toEqual([]);
  });
});

describe('withAbort', () => {
  it('信号已取消时立即拒绝；等待中取消时拒绝为 AbortError，之后的结果被忽略', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(withAbort(Promise.resolve('x'), aborted.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    const controller = new AbortController();
    const pending = deferred<string>();
    const guarded = withAbort(pending.promise, controller.signal);
    controller.abort();
    await expect(guarded).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve('late');
    await tick();
  });

  it('未取消时透传结果与错误', async () => {
    const controller = new AbortController();
    await expect(withAbort(Promise.resolve('value'), controller.signal)).resolves.toBe('value');
    await expect(withAbort(Promise.reject(new Error('fail')), controller.signal)).rejects.toThrow(
      'fail',
    );
  });
});

/* ------------------------------ 结果失效与事件 ------------------------------ */

describe('结果失效与事件', () => {
  const prepare = async (): Promise<WorkspaceApi> => {
    const workspace = lab.openRun([
      docOf('A', [src('s'), task('t'), task('u')], [edgeOf('s', 't')]),
    ]);
    await workspace.run();
    lab.events.length = 0;
    return workspace;
  };
  const expectKept = (workspace: WorkspaceApi): void => {
    expect(workspace.getRuntime().status).not.toBe('idle');
    expect(workspace.getRuntime().states.size).toBe(4);
  };
  const expectCleared = (workspace: WorkspaceApi): void => {
    expect(workspace.getRuntime()).toMatchObject({ status: 'idle', running: false });
    expect(workspace.getRuntime().states.size).toBe(0);
  };
  const kept = (workspace: WorkspaceApi): string[] =>
    [...workspace.getRuntime().states.keys()].sort();

  it.each<[string, (workspace: WorkspaceApi) => unknown]>([
    ['视口', (w) => w.setViewport({ x: 10, y: 10, zoom: 1.5 })],
    ['位置', (w) => w.updateNode('t', { position: { x: 40, y: 40 } })],
    ['尺寸', (w) => w.updateNode('t', { size: { width: 400, height: 300 } })],
    ['流程改名', (w) => w.rename('A', 'renamed')],
  ])('%s变更不清除运行结果', async (_name, operation) => {
    const workspace = await prepare();
    const before = workspace.getRuntime().status;
    operation(workspace);
    expectKept(workspace);
    expect(workspace.getRuntime().status).toBe(before);
  });

  it.each<[string, (workspace: WorkspaceApi) => unknown, string[]]>([
    ['节点配置', (w) => w.updateNode('s', { config: { value: 'changed' } }), [ENTRY_ID, 'u']],
    ['节点名称', (w) => w.updateNode('t', { name: 'renamed' }), [ENTRY_ID, 's', 'u']],
    ['新增连线', (w) => w.connect(conn('s', 'out', 'u', 'in')), [ENTRY_ID, 's', 't']],
    ['删除连线', (w) => w.disconnect('s-t-in'), [ENTRY_ID, 's', 'u']],
    ['新增节点', (w) => w.addNode('src', { x: 0, y: 0 }), [ENTRY_ID, 's', 't', 'u']],
    ['删除节点', (w) => w.deleteSelection({ nodeIds: ['u'] }), [ENTRY_ID, 's', 't']],
    ['复制子图', (w) => w.copySelection(['s']), [ENTRY_ID, 's', 't', 'u']],
  ])(
    '%s变更只让变化节点及其下游结果失效，其余结果保留并标记过期',
    async (_name, operation, remaining) => {
      const workspace = await prepare();
      operation(workspace);
      expect(kept(workspace)).toEqual([...remaining].sort());
      expect(workspace.getRuntime().status).toBe('stale');
    },
  );

  it('全部结果失效时回到尚未运行状态', async () => {
    const workspace = lab.openRun([docOf('A', [src('a')])]);
    await workspace.run();
    workspace.deleteSelection({ nodeIds: ['a', ENTRY_ID] });
    expectCleared(workspace);
  });

  it('撤销与重做内容变更同样只让相关结果失效', async () => {
    const workspace = await prepare();
    workspace.updateNode('s', { config: { value: 'changed' } });
    await workspace.run();
    workspace.undo();
    expect(kept(workspace)).toEqual([ENTRY_ID, 'u']);
    await workspace.run();
    workspace.redo();
    expect(kept(workspace)).toEqual([ENTRY_ID, 'u']);
    expect(workspace.getRuntime().status).toBe('stale');
  });

  it('撤销与重做纯布局变更保留结果，只发布 layout 事件', async () => {
    const workspace = await prepare();
    workspace.updateNode('t', { position: { x: 40, y: 40 } });
    lab.events.length = 0;
    workspace.undo();
    expectKept(workspace);
    workspace.redo();
    expectKept(workspace);
    expect(lab.events.map((event) => event.kind)).toEqual(['layout', 'layout']);
  });

  it('清除结果只影响本流程，其他流程的结果保持', async () => {
    const workspace = lab.openRun([docOf('A', [src('a')]), docOf('B', [src('b')])]);
    await workspace.run('A');
    await workspace.run('B');
    workspace.updateNode('a', { config: { value: 'changed' } }, 'A');
    expect([...workspace.getRuntime('A').states.keys()]).toEqual([ENTRY_ID]);
    expect(workspace.getRuntime('B').status).toBe('succeeded');
  });

  it('视口不入历史；布局与内容事件携带语义种类和节点', async () => {
    const workspace = await prepare();
    workspace.setViewport({ x: 1, y: 2, zoom: 1.2 });
    expect(workspace.canUndo()).toBe(false);
    workspace.updateNode('t', { position: { x: 5, y: 5 } });
    workspace.updateNode('t', { config: { x: 1 } });
    workspace.connect(conn('s', 'out', 'u', 'in'));
    expect(lab.events).toEqual([
      { id: 'A', kind: 'viewport' },
      { id: 'A', kind: 'layout', nodeIds: ['t'] },
      { id: 'A', kind: 'content', nodeIds: ['t'] },
      { id: 'A', kind: 'structure', nodeIds: undefined },
    ]);
  });

  it('没有实际变化的布局更新不产生历史和事件', async () => {
    const workspace = await prepare();
    workspace.updateNode('t', { position: { x: 0, y: 0 } });
    expect(workspace.canUndo()).toBe(false);
    expect(lab.events).toEqual([]);
  });

  it('越界视口被拒绝且不改变文档', async () => {
    const workspace = await prepare();
    const before = workspace.getDocument();
    expect(() => workspace.setViewport({ x: 0, y: 0, zoom: LIMITS.maxZoom + 1 })).toThrow(Error);
    expect(workspace.getDocument()).toBe(before);
  });

  it('保留结果的流程数超过上限时清理最早的结果并通知', async () => {
    const documents = Array.from({ length: LIMITS.resultDocuments + 2 }, (_, i) =>
      docOf(`D${i}`, [src(`n${i}`)]),
    );
    const workspace = lab.openRun(documents);
    for (const document of documents) await workspace.run(document.id);
    const withResults = documents.filter(
      (document) => workspace.getRuntime(document.id).states.size > 0,
    );
    expect(withResults).toHaveLength(LIMITS.resultDocuments);
    expect(workspace.getRuntime('D0').status).toBe('idle');
    expect(workspace.getRuntime('D1').status).toBe('idle');
    expect(workspace.getRuntime(`D${documents.length - 1}`).status).toBe('succeeded');
    expect(lab.events).toContainEqual({ id: 'D0', kind: 'runtime' });
  });

  it('getRuntime 返回快照：修改返回的状态表不会影响工作区内部状态', async () => {
    const workspace = await prepare();
    workspace.getRuntime().states.clear();
    expect(workspace.getRuntime().states.size).toBe(4);
    expect(workspace.getDocument()).toSatisfy(
      (document: WorkflowDocument) => Object.isFrozen(document) && Object.isFrozen(document.nodes),
    );
  });
});

/* ------------------------------ 开始节点与入口范围 ------------------------------ */

describe('开始节点与入口范围', () => {
  const entryCount = (document: WorkflowDocument): number =>
    document.nodes.filter((node) => node.type === 'entry').length;

  it('无开始节点的旧草稿可恢复、编辑和导出，但运行在任何执行器前被拒绝且不自动改图', async () => {
    const workspace = lab.open([docOf('A', [src('s'), task('t')], [edgeOf('s', 't')])]);
    expect(lab.errors).toEqual([]);
    workspace.updateNode('s', { config: { value: 'edited' } });
    expect(JSON.parse(workspace.exportDocument()).nodes).toHaveLength(2);
    await expect(workspace.run()).rejects.toThrow(Error);
    expect(lab.calls).toEqual([]);
    expect(workspace.getRuntime()).toMatchObject({ running: false, status: 'idle' });
    expect(workspace.getDocument().nodes.map((node) => node.id)).toEqual(['s', 't']);
  });

  it('开始节点没有出边时拒绝运行；删除入口后文档仍可编辑', async () => {
    const workspace = lab.open([docOf('A', [src('s'), entryNode()])]);
    await expect(workspace.run()).rejects.toThrow(Error);
    expect(lab.calls).toEqual([]);
    workspace.deleteSelection({ nodeIds: [ENTRY_ID] });
    expect(() => workspace.addNode('src', { x: 1, y: 1 })).not.toThrow(Error);
    expect(entryCount(workspace.getDocument())).toBe(0);
  });

  it('单份文档最多一个开始节点：解析、导入、复制、子图插入原子拒绝，复制整份流程有效', () => {
    const two = docOf('X', [entryNode('e1'), entryNode('e2'), src('s')], [ctlEdge('s', 'e1')]);
    expect(() => parseDocument(two, lab.registry)).toThrow(Error);
    expect(() =>
      parseDocument(docOf('X', [entryNode(), src('s')], [ctlEdge('s')]), lab.registry),
    ).not.toThrow(Error);
    expect(() => parseDocument(docOf('X', [src('s')]), lab.registry)).not.toThrow(Error);

    const workspace = lab.open([docOf('A', [src('s'), entryNode()], [ctlEdge('s')])]);
    const before = lab.snapshot(workspace);
    expect(() => workspace.importDocument(JSON.stringify(two))).toThrow(Error);
    expect(() => workspace.addNode('entry', { x: 0, y: 0 })).toThrow(Error);
    expect(() => workspace.copySelection([ENTRY_ID])).toThrow(Error);
    expect(() =>
      workspace.insertSubgraph({
        nodes: [entryNode('e9'), src('s9')],
        edges: [ctlEdge('s9', 'e9')],
      }),
    ).toThrow(Error);
    expect(lab.snapshot(workspace)).toEqual(before);

    const copy = workspace.duplicate('A');
    expect(entryCount(copy)).toBe(1);
  });

  it('没有入口的文档可新增一个开始节点，但不能一次插入多个', () => {
    const workspace = lab.open([docOf('A', [src('s')])]);
    expect(() =>
      workspace.insertSubgraph({ nodes: [entryNode('e1'), entryNode('e2')], edges: [] }),
    ).toThrow(Error);
    expect(workspace.addNode('entry', { x: 0, y: 0 }).type).toBe('entry');
    expect(() => workspace.addNode('entry', { x: 0, y: 0 })).toThrow(Error);
    expect(entryCount(workspace.getDocument())).toBe(1);
  });

  it('连线同时要求数据类型与端口 kind 相容：控制与数据端口不能互连，即使数据类型相同', () => {
    const base = { version: 1, category: 'test', defaults: {}, execute: () => ({}) };
    lab.registry.register({
      ...base,
      type: 'trigOut',
      label: 'trigOut',
      inputs: [],
      outputs: [{ id: 'out', label: 'out', dataType: 'trigger' }],
    });
    lab.registry.register({
      ...base,
      type: 'trigIn',
      label: 'trigIn',
      inputs: [{ id: 'in', label: 'in', dataType: 'trigger' }],
      outputs: [text('out')],
    });
    const document = parseDocument(
      docOf('A', [entryNode(), nodeOf('d', 'trigOut'), nodeOf('di', 'trigIn'), task('t')]),
      lab.registry,
    );
    const check = (connection: Connection): string | null =>
      validateConnection(document, lab.registry, connection);
    expect(check(conn(ENTRY_ID, 'ctl', 't', 'ctl'))).toBeNull();
    expect(check(conn('d', 'out', 't', 'ctl'))).not.toBeNull();
    expect(check(conn(ENTRY_ID, 'ctl', 'di', 'in'))).not.toBeNull();
    expect(check(conn(ENTRY_ID, 'ctl', 't', 'in'))).not.toBeNull();
  });

  it('入口先于所有节点执行，被动数据只在入口成功后读取；与节点在文档中的顺序无关', async () => {
    const workspace = lab.open([
      docOf('A', [note('d', 'payload'), task('t'), entryNode()], [edgeOf('d', 't'), ctlEdge('t')]),
    ]);
    const gate = lab.gate(ENTRY_ID);
    const finished = workspace.run();
    await vi.waitFor(() => expect(status(workspace, ENTRY_ID)).toBe('running'));
    await tick();
    expect(lab.calls).toEqual([]);
    expect([status(workspace, 'd'), status(workspace, 't')]).toEqual(['queued', 'queued']);
    gate.resolve({ ctl: true });
    await expect(finished).resolves.toMatchObject({ status: 'succeeded' });
    expect(lab.calls).toEqual(['d', 't']);
    expect(workspace.getRuntime().states.get('t')?.outputs).toEqual({ out: 't<payload' });
  });

  it('只执行从开始可达的任务及其所需被动数据；未触发的分支保持 skipped，被动数据不向其他出边扩张', async () => {
    const document = docOf(
      'A',
      [entryNode(), note('n', 'shared'), task('x'), task('y'), src('lone')],
      [edgeOf('n', 'x'), edgeOf('n', 'y'), ctlEdge('x')],
    );
    const workspace = lab.open([document]);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect([...lab.calls].sort()).toEqual(['n', 'x']);
    const states = workspace.getRuntime().states;
    expect(states.size).toBe(document.nodes.length);
    for (const id of ['y', 'lone']) {
      expect(states.get(id)).toMatchObject({ status: 'skipped', outputs: null });
      expect(states.get(id)?.message).toBeTruthy();
    }
  });

  it('可达节点依赖范围外任务时被跳过且不偷偷执行该任务，其他已触发分支继续', async () => {
    const workspace = lab.open([
      docOf(
        'A',
        [entryNode(), src('outside'), task('blocked'), note('n'), task('free')],
        [edgeOf('outside', 'blocked'), ctlEdge('blocked'), edgeOf('n', 'free'), ctlEdge('free')],
      ),
    ]);
    await workspace.run();
    expect(lab.calls).not.toContain('outside');
    expect(lab.calls).not.toContain('blocked');
    expect([status(workspace, 'outside'), status(workspace, 'blocked')]).toEqual([
      'skipped',
      'skipped',
    ]);
    expect(status(workspace, 'free')).toBe('succeeded');
  });

  it('只靠开始触发的源任务失败时不被其他成功的数据任务掩盖，整体为 partial', async () => {
    const workspace = lab.open([
      docOf(
        'A',
        [entryNode(), src('a'), src('b'), task('t')],
        [ctlEdge('a'), ctlEdge('b'), edgeOf('b', 't')],
      ),
    ]);
    lab.handlers.set('a', () => {
      throw new Error('control-only failure');
    });
    await expect(workspace.run()).resolves.toMatchObject({ status: 'partial' });
    expect(status(workspace, 'a')).toBe('failed');
    expect([status(workspace, 'b'), status(workspace, 't')]).toEqual(['succeeded', 'succeeded']);
  });

  it('开始与被动数据节点不参与聚合：唯一的处理任务失败时整体为 failed', async () => {
    const workspace = lab.open([
      docOf('A', [entryNode(), note('n'), task('x')], [edgeOf('n', 'x'), ctlEdge('x')]),
    ]);
    lab.handlers.set('x', () => ({}));
    await expect(workspace.run()).resolves.toMatchObject({ status: 'failed' });
    expect([status(workspace, ENTRY_ID), status(workspace, 'n'), status(workspace, 'x')]).toEqual([
      'succeeded',
      'succeeded',
      'failed',
    ]);
  });

  it.each<[string, Handler]>([
    [
      '抛出异常',
      () => {
        throw new Error('entry boom');
      },
    ],
    ['返回非法触发值', () => ({ ctl: false })],
  ])('入口%s时整体直接 failed，不执行任何其他节点', async (_name, handler) => {
    const workspace = lab.open([
      docOf(
        'A',
        [entryNode(), src('s'), note('n'), task('t')],
        [edgeOf('n', 't'), ctlEdge('s'), ctlEdge('t')],
      ),
    ]);
    lab.handlers.set(ENTRY_ID, handler);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'failed' });
    expect(status(workspace, ENTRY_ID)).toBe('failed');
    expect(lab.calls).toEqual([]);
    for (const id of ['s', 'n', 't'])
      expect(['running', 'succeeded']).not.toContain(status(workspace, id));
    expect(workspace.getRuntime().running).toBe(false);
  });

  it('入口执行中被停止时 run 以 cancelled 结束，其余节点不执行', async () => {
    const workspace = lab.open([docOf('A', [entryNode(), src('s')], [ctlEdge('s')])]);
    lab.gate(ENTRY_ID);
    const finished = workspace.run();
    await vi.waitFor(() => expect(status(workspace, ENTRY_ID)).toBe('running'));
    workspace.stop();
    await expect(finished).resolves.toMatchObject({ status: 'cancelled' });
    expect(status(workspace, ENTRY_ID)).toBe('cancelled');
    expect(lab.calls).toEqual([]);
  });

  it('控制输入只出现在只读 controls 中，不混入业务 inputs', async () => {
    const workspace = lab.open([
      docOf(
        'A',
        [entryNode(), src('s'), task('t')],
        [edgeOf('s', 't'), ctlEdge('s'), ctlEdge('t')],
      ),
    ]);
    const contexts = new Map<string, ExecuteContext>();
    for (const id of ['s', 't'])
      lab.handlers.set(id, (context) => (contexts.set(id, context), { out: id }));
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(Object.keys(contexts.get('s')?.inputs ?? {})).toEqual([]);
    expect(Object.keys(contexts.get('t')?.inputs ?? {})).toEqual(['in']);
    for (const context of contexts.values()) {
      expect({ ...context.controls }).toEqual({ ctl: true });
      expect(Object.isFrozen(context.controls)).toBe(true);
    }
  });
});

/* ------------------------------ 从节点运行 ------------------------------ */

describe('从节点运行', () => {
  const chain = (): WorkflowDocument =>
    docOf('A', [src('s'), task('t'), task('v'), task('w')], [edgeOf('s', 't'), edgeOf('t', 'v')]);

  it('复用上游成功结果，只执行指定节点及其下游，其他分支结果保持不变', async () => {
    const workspace = lab.openRun([chain()]);
    await workspace.run();
    const upstream = workspace.getRuntime().states.get('s');
    const branch = workspace.getRuntime().states.get('w');
    const before = workspace.getRuntime().states.get('v')?.outputs;
    lab.calls.length = 0;
    await expect(workspace.runFrom('t')).resolves.toMatchObject({ status: 'succeeded' });
    expect(lab.calls).toEqual(['t', 'v']);
    const states = workspace.getRuntime().states;
    expect(states.get('s')).toEqual(upstream);
    expect(states.get('w')).toEqual(branch);
    expect(states.get('v')?.outputs).toEqual(before);
  });

  it('编辑节点后只需从该节点重跑，上游结果无需重新计算', async () => {
    const workspace = lab.openRun([chain()]);
    await workspace.run();
    workspace.updateNode('t', { name: 'renamed' });
    expect(status(workspace, 't')).toBeUndefined();
    expect(status(workspace, 's')).toBe('succeeded');
    lab.calls.length = 0;
    await workspace.runFrom('t');
    expect(lab.calls).toEqual(['t', 'v']);
    expect(workspace.getRuntime().status).toBe('succeeded');
  });

  it('上游任务没有可复用结果时在执行任何节点前拒绝', async () => {
    const workspace = lab.openRun([chain()]);
    await expect(workspace.runFrom('t')).rejects.toThrow('没有可复用的成功结果');
    expect(lab.calls).toEqual([]);
    expect(workspace.getRuntime()).toMatchObject({ status: 'idle', running: false });
  });

  it('开始与被动数据上游缺少结果时直接重新求值，不要求先运行整图', async () => {
    const workspace = lab.open([
      docOf('A', [note('n', 'first'), task('t'), entryNode()], [edgeOf('n', 't'), ctlEdge('t')]),
    ]);
    await workspace.run();
    workspace.updateNode('n', { config: { value: 'second' } });
    lab.calls.length = 0;
    await workspace.runFrom('t');
    expect(lab.calls).toEqual(['n', 't']);
    expect(String(workspace.getRuntime().states.get('t')?.outputs?.out)).toContain('second');
  });

  it('未连接开始节点的节点不能单独运行', async () => {
    const workspace = lab.openRun([docOf('A', [src('s')])]);
    const orphan = workspace.addNode('task', { x: 0, y: 0 });
    await expect(workspace.runFrom(orphan.id)).rejects.toThrow('未连接开始节点');
  });
});

/* ------------------------------ 语义子类型 ------------------------------ */

describe('语义子类型', () => {
  const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
  const register = (): void => {
    lab.registry.registerDataType('rows', nonEmpty, { base: 'list' });
    lab.registry.registerDataType('cols', Array.isArray, { base: 'list' });
    lab.registry.register({
      type: 'rows-src',
      version: 1,
      label: 'rows-src',
      category: 'test',
      inputs: [ctlPort()],
      outputs: [{ id: 'out', label: 'out', dataType: 'rows' }],
      defaults: {},
      execute: () => ({ out: [1] }),
    });
    for (const dataType of ['rows', 'list', 'cols']) {
      lab.registry.register({
        type: `${dataType}-sink`,
        version: 1,
        label: `${dataType}-sink`,
        category: 'test',
        inputs: [ctlPort(), { id: 'in', label: '数据', dataType, required: true }],
        outputs: [text('out')],
        defaults: {},
        execute: ({ inputs }) => ({ out: JSON.stringify(inputs.in) }),
      });
    }
  };

  it('子类型只能声明已注册且本身不是子类型的基类型', () => {
    expect(() => lab.registry.registerDataType('orphan', () => true, { base: 'missing' })).toThrow(
      Error,
    );
    lab.registry.registerDataType('rows', nonEmpty, { base: 'list' });
    expect(() => lab.registry.registerDataType('deep', () => true, { base: 'rows' })).toThrow(
      Error,
    );
    expect(lab.registry.compatible('rows', 'list')).toBe(true);
    expect(lab.registry.compatible('list', 'rows')).toBe(true);
    expect(lab.registry.compatible('rows', 'rows')).toBe(true);
    expect(lab.registry.compatible('rows', 'text')).toBe(false);
  });

  it('子类型与基类型双向可连，同一基类型下的不同子类型互斥', () => {
    register();
    const document = parseDocument(
      docOf('A', [
        nodeOf('r', 'rows-src'),
        nodeOf('b', 'bag'),
        nodeOf('l', 'list-sink'),
        nodeOf('k', 'rows-sink'),
        nodeOf('c', 'cols-sink'),
      ]),
      lab.registry,
    );
    expect(validateConnection(document, lab.registry, conn('r', 'out', 'l', 'in'))).toBeNull();
    expect(validateConnection(document, lab.registry, conn('b', 'out', 'k', 'in'))).toBeNull();
    expect(validateConnection(document, lab.registry, conn('r', 'out', 'c', 'in'))).toBe(
      '连接点的数据类型不兼容。',
    );
  });

  it('基类型数据进入子类型输入时按输入类型校验，不合格时节点失败且不执行', async () => {
    register();
    const workspace = lab.openRun([
      docOf(
        'A',
        [
          nodeOf('b', 'bag'),
          nodeOf('k', 'rows-sink'),
          nodeOf('r', 'rows-src'),
          nodeOf('l', 'list-sink'),
        ],
        [edgeOf('b', 'k'), edgeOf('r', 'l')],
      ),
    ]);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'partial' });
    expect(workspace.getRuntime().states.get('k')).toMatchObject({
      status: 'failed',
      message: '输入“数据”不符合 rows 数据类型。',
    });
    expect(workspace.getRuntime().states.get('l')?.outputs).toEqual({ out: '[1]' });
  });
});

/* ------------------------------ 并发名额让出 ------------------------------ */

describe('等待人工操作时让出并发名额', () => {
  it('执行器通过 suspend 等待时不占名额，其他节点照常运行；结束后重新取得名额完成', async () => {
    const ids = Array.from({ length: LIMITS.concurrency }, (_, index) => `w${index}`);
    const workspace = lab.openRun([docOf('A', [...ids.map((id) => src(id)), src('quick')])]);
    const gate = deferred();
    for (const id of ids)
      lab.handlers.set(id, ({ suspend }) => suspend(() => gate.promise).then(() => ({ out: id })));
    const run = workspace.run();
    await vi.waitFor(() => expect(status(workspace, 'quick')).toBe('succeeded'));
    for (const id of ids) expect(status(workspace, id)).toBe('running');
    gate.resolve(undefined);
    await expect(run).resolves.toMatchObject({ status: 'succeeded' });
  });
});

/* ------------------------------ 显式版本升级 ------------------------------ */

describe('显式版本升级', () => {
  const register = (): void => {
    lab.registry.register({
      type: 'migrating',
      version: 1,
      label: 'migrating',
      category: 'test',
      inputs: [],
      outputs: [text('out')],
      defaults: { old: '' },
      execute: ({ node }) => ({ out: String(node.config.old) }),
    });
    lab.registry.register({
      type: 'migrating',
      version: 2,
      label: 'migrating',
      category: 'test',
      inputs: [],
      outputs: [text('out')],
      defaults: { value: '' },
      execute: ({ node }) => ({ out: String(node.config.value) }),
      migrate: (config) => ({ value: config.old }),
    });
  };

  it('按迁移函数升级为最新版本，是一次可撤销编辑', () => {
    register();
    const workspace = lab.open([docOf('A', [nodeOf('m', 'migrating', { old: 'kept' }, 1)])]);
    workspace.upgradeNode('m');
    expect(workspace.getDocument().nodes[0]).toMatchObject({
      version: 2,
      config: { value: 'kept' },
    });
    workspace.undo();
    expect(workspace.getDocument().nodes[0]).toMatchObject({ version: 1, config: { old: 'kept' } });
  });

  it('已是最新版本或缺少迁移方案时拒绝且不修改文档', () => {
    register();
    const workspace = lab.open([
      docOf('A', [nodeOf('m', 'migrating', { value: 'x' }, 2), nodeOf('old', 'versioned', {}, 1)]),
    ]);
    const before = lab.snapshot(workspace);
    expect(() => workspace.upgradeNode('m')).toThrow('最新版本');
    expect(() => workspace.upgradeNode('old')).toThrow('迁移方案');
    expect(lab.snapshot(workspace)).toEqual(before);
  });
});
