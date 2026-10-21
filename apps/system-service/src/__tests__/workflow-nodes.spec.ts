import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadScript = createRequire(resolve(process.cwd(), 'package.json'));
const { Workspace, STORAGE_KEY, NODE_EXECUTION, PORT_KIND } = loadScript(resolve(process.cwd(), 'public/js/workflow-core.js'));
const { createRegistry, createServices, isDiffResult } = loadScript(resolve(process.cwd(), 'public/js/workflow-nodes.js'));

/** 构造与真实接口一致的紧凑结果。 */
function result(format = 'json') {
  const leftText = format === 'json' ? '{"a":1}' : 'A=1';
  const rightText = format === 'json' ? '{"a":2}' : 'A=2';
  return {
    format, leftText, rightText,
    stats: { added: 0, removed: 0, modified: 1 },
    tree: { key: '$', path: '$', type: 'object', status: 'modified', hasLeft: true, hasRight: true, leftDisplay: '{ 1 个键 }', rightDisplay: '{ 1 个键 }', children: [] },
    segments: { left: [{ text: leftText, status: 'modified' }], right: [{ text: rightText, status: 'modified' }] },
  };
}

type EntryMode = 'connected' | 'isolated' | 'none';
interface PipelineOptions {
  storage?: unknown;
  format?: string;
  entry?: EntryMode;
}

/** 使用真实内置节点构建完整数据流；entry 控制开始节点缺失、孤立或已连接触发线。 */
function pipeline(services: unknown, options: PipelineOptions = {}) {
  const { storage, format = 'json', entry = 'connected' } = options;
  const workspace = new Workspace({ registry: createRegistry(), services, storage });
  const a = workspace.addNode('text', { x: 0, y: 0 });
  const b = workspace.addNode('text', { x: 0, y: 320 });
  workspace.updateNode(a.id, { config: { text: format === 'json' ? '{"a":1}' : 'A=1' } });
  workspace.updateNode(b.id, { config: { text: format === 'json' ? '{"a":2}' : 'A=2' } });
  const compare = workspace.addNode(`${format}-compare`, { x: 400, y: 0 });
  const output = workspace.addNode('diff-result', { x: 750, y: 0 });
  const start = entry === 'none' ? null : workspace.addNode('start', { x: 0, y: -260 });
  for (const [source, port, target, input] of [[a, 'text', compare, 'a'], [b, 'text', compare, 'b'], [compare, 'diff', output, 'diff']]) {
    workspace.connect({ source: { nodeId: source.id, port }, target: { nodeId: target.id, port: input } });
  }
  if (start && entry === 'connected') workspace.connect({ source: { nodeId: start.id, port: 'trigger' }, target: { nodeId: compare.id, port: 'trigger' } });
  return { workspace, a, b, compare, output, start };
}

/** 构造只含对比与结果的成功响应。 */
function successRequest(format = 'json') {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 200, data: result(format) }) }));
}

afterEach(() => vi.useRealTimers());

describe('workflow built-in nodes and comparison boundary', () => {
  it.each(['json', 'env'])('runs a full %s graph only when requested and never persists outputs', async (format) => {
    const data = result(format);
    const request = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 200, data }) }));
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) || null, setItem: (key: string, value: string) => saved.set(key, value) };
    const { workspace, a, b, compare, output, start } = pipeline(createServices({ request }), { storage, format });
    const original = workspace.exportDocument();
    expect(request).not.toHaveBeenCalled();
    expect(new Workspace({ registry: createRegistry(), services: createServices({ request }), storage }).getRuntime().status).toBe('idle');
    expect(request).not.toHaveBeenCalled();

    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(request).toHaveBeenCalledTimes(1);
    const [path, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/content-compare/${format}`);
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(options.body))).toEqual({ left: workspace.getDocument().nodes.find((node: { id: string }) => node.id === a.id).config.text, right: workspace.getDocument().nodes.find((node: { id: string }) => node.id === b.id).config.text });
    const runtime = workspace.getRuntime();
    expect(runtime.states.get(start.id)).toMatchObject({ status: 'succeeded', outputs: { trigger: true } });
    expect(runtime.states.get(compare.id).outputs.diff).toEqual(data);
    expect(runtime.states.get(output.id).outputs.diff).toBe(runtime.states.get(compare.id).outputs.diff);
    expect(Object.isFrozen(runtime.states.get(output.id).outputs.diff.tree)).toBe(true);
    expect(workspace.exportDocument()).toBe(original);
    const persisted = JSON.parse(saved.get(STORAGE_KEY)!);
    expect(persisted.documents[0].nodes.find((node: { id: string }) => node.id === a.id).config.text).toContain(format === 'json' ? '"a"' : 'A=');
    expect(saved.get(STORAGE_KEY)).not.toContain('segments');
    expect(saved.get(STORAGE_KEY)).not.toContain('runId');
    expect(saved.get(STORAGE_KEY)).not.toContain('outputs');
  });

  it('shows safe side-specific errors, blocks the result node and leaves inputs intact', async () => {
    const request = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ code: 400, errors: { left: [{ line: 2, message: '不是有效 JSON。' }], right: [{ message: '内容不能为空。' }] } }) }));
    const { workspace, compare, output, start } = pipeline(createServices({ request }));
    const before = workspace.exportDocument();
    await expect(workspace.run()).resolves.toMatchObject({ status: 'failed' });
    expect(workspace.getRuntime().states.get(start.id).status).toBe('succeeded');
    expect(workspace.getRuntime().states.get(compare.id)).toMatchObject({ status: 'failed', outputs: null });
    expect(workspace.getRuntime().states.get(compare.id).message).toContain('A 第 2 行');
    expect(workspace.getRuntime().states.get(compare.id).message).toContain('B：内容不能为空');
    expect(workspace.getRuntime().states.get(output.id).status).toBe('skipped');
    expect(workspace.exportDocument()).toBe(before);
  });

  it('does not call a request for a cancelled run or a non-whitelisted route', async () => {
    const request = vi.fn();
    const service = createServices({ request });
    const controller = new AbortController();
    controller.abort();
    await expect(service.compare({ format: 'json', left: '', right: '', signal: controller.signal })).rejects.toThrow('停止');
    await expect(service.compare({ format: 'https://other.example', left: '', right: '' })).rejects.toThrow('格式');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects oversized inputs before sending the request but passes legitimate empty strings to server validation', async () => {
    const request = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ code: 400 }) }));
    const service = createServices({ request });
    await expect(service.compare({ format: 'json', left: 'x'.repeat(500_001), right: '' })).rejects.toThrow('500000');
    expect(request).not.toHaveBeenCalled();
    await expect(service.compare({ format: 'json', left: '', right: '' })).rejects.toThrow('400');
    const [, options] = request.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(options.body)).toEqual({ left: '', right: '' });
  });

  it('turns malformed JSON and native network errors into messages without leaking original content', async () => {
    for (const request of [
      async () => { throw new Error('private-env-secret'); },
      async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('private-env-secret'); } }),
    ]) {
      await expect(createServices({ request }).compare({ format: 'json', left: '{}', right: '{}' })).rejects.toThrow('对比服务暂不可用');
    }
  });

  it('treats invalid successful payloads as failure, not a usable diff', async () => {
    const malformed = result();
    malformed.segments.left[0].text = 'not-the-rendered-source';
    expect(isDiffResult(malformed)).toBe(false);
    const request = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 200, data: malformed }) }));
    const { workspace, compare } = pipeline(createServices({ request }));
    await workspace.run();
    expect(workspace.getRuntime().states.get(compare.id)).toMatchObject({ status: 'failed', outputs: null });
  });

  it('times out even if the request ignores AbortSignal and never returns', async () => {
    vi.useFakeTimers();
    const request = vi.fn(() => new Promise(() => {}));
    const pending = createServices({ request, timeoutMs: 100 }).compare({ format: 'env', left: 'A=1', right: 'A=2' });
    const outcome = pending.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect((await outcome).message).toContain('超时');
    const [, options] = request.mock.calls[0] as unknown as [string, { signal: AbortSignal }];
    expect(options.signal.aborted).toBe(true);
  });

  it('cancels while reading a response body and does not accept the late payload', async () => {
    let complete!: (value: unknown) => void;
    const body = new Promise((resolve) => { complete = resolve; });
    const request = vi.fn(async () => ({ ok: true, status: 200, json: () => body }));
    const controller = new AbortController();
    const pending = createServices({ request }).compare({ format: 'json', left: '{}', right: '{}', signal: controller.signal });
    const outcome = pending.catch((error: Error) => error);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect((await outcome).message).toContain('停止');
    complete({ code: 200, data: result() });
  });

  it('preserves unknown node definitions on import without allowing imported request addresses or code to run', async () => {
    const request = vi.fn();
    const { workspace } = pipeline(createServices({ request }));
    const document = JSON.parse(workspace.exportDocument());
    document.nodes[0].type = 'future-node';
    document.nodes[0].version = 7;
    document.nodes[0].config = { url: 'https://not-allowed.example', execute: 'alert(1)', nested: JSON.parse('{"__proto__":{"polluted":true}}') };
    workspace.importDocument(document);
    expect(JSON.parse(workspace.exportDocument()).nodes[0].config).toEqual(document.nodes[0].config);
    await expect(workspace.run()).rejects.toThrow('尚未安装');
    expect(request).not.toHaveBeenCalled();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('registers start as the only entry, text as passive data and keeps control ports apart from data inputs', () => {
    const registry = createRegistry();
    const definitions = registry.list();
    expect(definitions.map((definition: { type: string; execution: string }) => [definition.type, definition.execution])).toEqual([
      ['start', NODE_EXECUTION.entry], ['text', NODE_EXECUTION.data], ['json-compare', NODE_EXECUTION.task],
      ['env-compare', NODE_EXECUTION.task], ['diff-result', NODE_EXECUTION.task],
    ]);
    expect(definitions[0]).toMatchObject({ category: '流程控制', inputs: [], outputs: [{ id: 'trigger', dataType: 'trigger', kind: PORT_KIND.control }] });
    for (const type of ['json-compare', 'env-compare']) {
      const { inputs, outputs } = registry.get(type, 1);
      expect(inputs.map((port: { id: string }) => port.id)).toEqual(['trigger', 'a', 'b']);
      expect(inputs[0]).toMatchObject({ kind: PORT_KIND.control, dataType: 'trigger' });
      expect(inputs[0].required).toBeUndefined();
      expect(inputs.slice(1).every((port: { required: boolean; dataType: string }) => port.required === true && port.dataType === 'text')).toBe(true);
      expect(outputs).toEqual([{ id: 'diff', label: '对比结果', dataType: 'diff' }]);
    }
    const isTrigger = registry.dataTypes.get('trigger');
    expect([isTrigger(true), isTrigger(false), isTrigger('true')]).toEqual([true, false, false]);
  });

  it.each([
    ['none', '请先添加开始节点'],
    ['isolated', '开始节点未连接后续流程'],
  ])('rejects a graph with %s start before any executor or request runs', async (entry, message) => {
    const request = successRequest();
    const { workspace } = pipeline(createServices({ request }), { entry: entry as EntryMode });
    await expect(workspace.run()).rejects.toThrow(message);
    expect(request).not.toHaveBeenCalled();
    expect(workspace.getRuntime()).toMatchObject({ running: false, status: 'idle' });
    expect(workspace.getRuntime().states.size).toBe(0);
  });

  it('does not trust execution roles supplied by imported node fields or config', async () => {
    const request = vi.fn();
    const { workspace } = pipeline(createServices({ request }), { entry: 'none' });
    const imported = JSON.parse(workspace.exportDocument());
    for (const node of imported.nodes) {
      node.execution = 'entry';
      node.config.execution = 'entry';
    }
    workspace.importDocument(imported);
    const exported = JSON.parse(workspace.exportDocument());
    expect(exported.nodes.every((node: Record<string, unknown>) => !Object.hasOwn(node, 'execution'))).toBe(true);
    await expect(workspace.run()).rejects.toThrow('开始节点');
    expect(request).not.toHaveBeenCalled();
  });

  it('restores a legacy v1 graph without start untouched, then runs it once a start is connected', async () => {
    const request = successRequest();
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) || null, setItem: (key: string, value: string) => saved.set(key, value) };
    const legacy = pipeline(createServices({ request }), { storage, entry: 'none' });
    const restored = new Workspace({ registry: createRegistry(), services: createServices({ request }), storage });
    expect(restored.storageProtected).toBe(false);
    expect(restored.exportDocument()).toBe(legacy.workspace.exportDocument());
    expect(restored.getDocument().nodes.map((node: { type: string }) => node.type)).toEqual(['text', 'text', 'json-compare', 'diff-result']);
    expect(restored.getDocument().edges).toHaveLength(3);
    await expect(restored.run()).rejects.toThrow('开始节点');
    expect(request).not.toHaveBeenCalled();

    const start = restored.addNode('start', { x: 0, y: -260 });
    restored.connect({ source: { nodeId: start.id, port: 'trigger' }, target: { nodeId: legacy.compare.id, port: 'trigger' } });
    await expect(restored.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not run or request an untriggered comparison that shares the same text sources', async () => {
    const request = successRequest();
    const { workspace, a, b, compare, output, start } = pipeline(createServices({ request }));
    const other = workspace.addNode('json-compare', { x: 400, y: 400 });
    const otherOutput = workspace.addNode('diff-result', { x: 750, y: 400 });
    for (const [source, port, target, input] of [[a, 'text', other, 'a'], [b, 'text', other, 'b'], [other, 'diff', otherOutput, 'diff']]) {
      workspace.connect({ source: { nodeId: source.id, port }, target: { nodeId: target.id, port: input } });
    }
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(request).toHaveBeenCalledTimes(1);
    const { states } = workspace.getRuntime();
    for (const node of [start, a, b, compare, output]) expect(states.get(node.id).status).toBe('succeeded');
    for (const node of [other, otherOutput]) expect(states.get(node.id)).toMatchObject({ status: 'skipped', outputs: null });
  });

  it('runs the entry with the run signal before the comparison receives only the real left and right text', async () => {
    const registry = createRegistry();
    const entry = vi.fn((_context: unknown) => ({ trigger: true }));
    registry.register({
      type: 'qa-entry', version: 1, label: '测试入口', execution: NODE_EXECUTION.entry, inputs: [],
      outputs: [{ id: 'trigger', label: '启动', dataType: 'trigger', kind: PORT_KIND.control }], size: { width: 220, height: 180 }, execute: entry,
    });
    const compare = vi.fn(async (_options: unknown) => result());
    const workspace = new Workspace({ registry, services: { compare } });
    const nodes = ['qa-entry', 'text', 'text', 'json-compare'].map((type, index) => workspace.addNode(type, { x: index * 400, y: 0 }));
    const [qaEntry, left, right, comparison] = nodes;
    workspace.updateNode(left.id, { config: { text: '{"x":1}' } });
    workspace.updateNode(right.id, { config: { text: '{"x":2}' } });
    for (const [source, port, target, input] of [[qaEntry, 'trigger', comparison, 'trigger'], [left, 'text', comparison, 'a'], [right, 'text', comparison, 'b']]) {
      workspace.connect({ source: { nodeId: source.id, port }, target: { nodeId: target.id, port: input } });
    }
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    const [context] = entry.mock.calls[0] as unknown as [{ signal: AbortSignal; inputs: object; controls: object }];
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(context.inputs)).toEqual([]);
    expect(Object.keys(context.controls)).toEqual([]);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][0]).toEqual({ format: 'json', left: '{"x":1}', right: '{"x":2}', signal: expect.any(AbortSignal) });
    expect(entry.mock.invocationCallOrder[0]).toBeLessThan(compare.mock.invocationCallOrder[0]);
  });

  it('atomically rejects a second start from add, copy, subgraph insert and import while whole-flow copy stays valid', () => {
    const { workspace, start } = pipeline(createServices({ request: vi.fn() }));
    const before = workspace.exportDocument();
    const second = { ...JSON.parse(before).nodes.find((node: { type: string }) => node.type === 'start'), id: 'second-start' };
    const withSecond = { ...JSON.parse(before), nodes: [...JSON.parse(before).nodes, second] };
    const count = workspace.documents.length;
    expect(() => workspace.addNode('start', { x: 0, y: 0 })).toThrow('一个开始节点');
    expect(() => workspace.copySelection([start.id])).toThrow('一个开始节点');
    expect(() => workspace.insertSubgraph({ nodes: [second], edges: [] })).toThrow('一个开始节点');
    expect(() => workspace.importDocument(withSecond)).toThrow('一个开始节点');
    expect(workspace.exportDocument()).toBe(before);
    expect(workspace.documents).toHaveLength(count);

    const copy = workspace.duplicate(workspace.activeId);
    expect(copy.nodes.filter((node: { type: string }) => node.type === 'start')).toHaveLength(1);
    expect(workspace.documents).toHaveLength(count + 1);
  });
});
