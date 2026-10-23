import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadScript = createRequire(__filename);
const Core = loadScript(resolve(__dirname, '../../public/js/workflow-core.js'));
const Data = loadScript(resolve(__dirname, '../../public/js/workflow-data.js'));
const Capabilities = loadScript(resolve(__dirname, '../../public/js/workflow-capabilities.js'));
const { createRegistry, createServices } = loadScript(
  resolve(__dirname, '../../public/js/workflow-nodes.js'),
);
const TYPES = [
  'date-range',
  'json-input',
  'json-parse',
  'json-pick',
  'json-merge',
  'text-template',
  'github-commits',
  'ai-text',
  'text-result',
  'feishu-find-row',
  'feishu-write-cells',
];
const REMOTE_TYPES = ['github-commits', 'ai-text', 'feishu-find-row', 'feishu-write-cells'];
const WIKI = 'https://team.feishu.cn/wiki/docToken?sheet=sheet01';
const TARGET = { wikiUrl: WIKI, row: 42, sheetId: 'sheet01' };
const RANGE = {
  since: '2026-10-12T00:00:00.000Z',
  until: '2026-10-18T23:59:59.999Z',
  startDate: '2026-10-12',
  endDate: '2026-10-18',
};
const CREDENTIALS = {
  githubToken: 'private-github-token',
  feishuAppId: 'app01',
  feishuAppSecret: 'private-feishu-secret',
  ai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'private-ai-key', model: 'test-model' },
};
const COMMIT = {
  hash: 'abcdef0123456789',
  author: 'Alice',
  date: '2026-10-14T01:02:03Z',
  subject: 'plain English commit',
  body: '',
  isMerge: true,
};
const registry = createRegistry();

/** 节点库中各类型的最新版本定义，与新建节点一致。 */
function latest(type: string) {
  return registry.list().find((definition: { type: string }) => definition.type === type);
}

/** 从真实定义获取默认配置，避免测试维护第二套默认值。 */
function config(type: string, patch: Record<string, unknown> = {}) {
  return { ...latest(type).defaults, ...patch };
}

/** 构造独立于网络和 DOM 的实际成功 envelope。 */
function response(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ code: 200, data }) };
}

/** 建立可控制完成时机的依赖，验证取消和迟到隔离。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 推进异步准备阶段，不推进超时或依赖真实时间。 */
async function flushMicrotasks() {
  for (let index = 0; index < 100; index += 1) await Promise.resolve();
}

/** 只按显式节点端口构造真实 DAG。 */
function connect(
  workspace: InstanceType<typeof Core.Workspace>,
  endpoints: [{ id: string }, string, { id: string }, string],
) {
  const [from, output, to, input] = endpoints;
  workspace.connect({
    source: { nodeId: from.id, port: output },
    target: { nodeId: to.id, port: input },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('workflow atomic registration and metadata', () => {
  it('appends the atomic definitions after the original five with typed ports and generic renderers', () => {
    const capability = vi.fn();
    const textResult = vi.fn();
    const installed = createRegistry({ capability, textResult });
    const definitions = installed.list();
    expect(definitions.map((definition: { type: string }) => definition.type)).toEqual([
      'start',
      'text',
      'json-compare',
      'env-compare',
      'diff-result',
      ...TYPES,
    ]);
    for (const type of TYPES) {
      const definition = definitions.find((item: { type: string }) => item.type === type);
      expect(definition.render).toBe(type === 'text-result' ? textResult : capability);
      const keys = definition.fields.map((field: { key: string }) => field.key);
      expect(REMOTE_TYPES.includes(type) ? [...keys, 'credentialRef'] : keys).toEqual(
        Object.keys(definition.defaults),
      );
      expect(
        definition.fields.some((field: { key: string }) => field.key === 'credentialRef'),
      ).toBe(false);
      expect(definition.validateConfig(definition.defaults)).toBeNull();
      for (const field of definition.fields) {
        expect(['text', 'textarea', 'number', 'select', 'checkbox', 'date']).toContain(field.type);
        expect(typeof field.label).toBe('string');
      }
      for (const field of definition.fields.filter(
        (item: { type: string }) => item.type === 'select',
      )) {
        expect(
          field.options.every(
            (option: { value: string; label: string }) =>
              typeof option.value === 'string' && typeof option.label === 'string',
          ),
        ).toBe(true);
      }
    }
    expect(
      definitions
        .filter((definition: { version: number }) => definition.version > 1)
        .map((definition: { type: string }) => definition.type),
    ).toEqual(['json-pick', 'text-template', 'ai-text', 'feishu-write-cells']);
    for (const type of ['date-range', 'json-input']) expect(installed.get(type).inputs).toEqual([]);
    for (const type of TYPES.filter((item) => !['date-range', 'json-input'].includes(item))) {
      expect(latest(type).inputs[0]).toMatchObject({
        id: 'trigger',
        kind: Core.PORT_KIND.control,
        dataType: 'trigger',
      });
    }
    expect(installed.dataTypes.get('json')({ a: [1, null] })).toBe(true);
    expect(installed.dataTypes.get('json')({ a: NaN })).toBe(false);
    expect(Capabilities.REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(Capabilities.CREDENTIAL_STORAGE_KEY).toBe('nestcloud:release-tokens:v1');
  });

  it.each([
    ['date-range', RANGE, { since: '2026-10-12' }],
    ['commit-list', [COMMIT], [{ subject: 'missing hash' }]],
    ['match-list', [{ column: 'A', value: 'Alice', mode: 'equals' }], []],
    ['sheet-target', TARGET, { wikiUrl: 'https://evil.example/wiki/x?sheet=a', row: 1 }],
    ['cell-matrix', [['a', 1, null]], [['a'], ['b', 'c']]],
  ])('registers %s as a json subtype with a structural validator', (name, valid, invalid) => {
    expect(registry.compatible(name, 'json')).toBe(true);
    expect(registry.compatible('json', name)).toBe(true);
    expect(registry.compatible(name, name === 'cell-matrix' ? 'date-range' : 'cell-matrix')).toBe(
      false,
    );
    expect(registry.dataTypes.get(name)(valid)).toBe(true);
    expect(registry.dataTypes.get(name)(invalid)).toBe(false);
  });

  it('rejects connecting different semantic subtypes while keeping generic JSON connections', () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const github = workspace.addNode('github-commits', { x: 0, y: 0 });
    const writer = workspace.addNode('feishu-write-cells', { x: 400, y: 0 });
    const dates = workspace.addNode('date-range', { x: 0, y: 400 });
    const lookup = workspace.addNode('feishu-find-row', { x: 400, y: 400 });
    const input = workspace.addNode('json-input', { x: 0, y: 800 });
    const template = workspace.addNode('text-template', { x: 800, y: 0 });
    expect(() => connect(workspace, [github, 'data', writer, 'values'])).toThrow('类型');
    expect(() => connect(workspace, [dates, 'range', lookup, 'matches'])).toThrow('类型');
    expect(() => connect(workspace, [input, 'data', lookup, 'matches'])).not.toThrow();
    expect(() => connect(workspace, [github, 'data', template, 'context'])).not.toThrow();
    expect(template.version).toBe(2);
    expect(latest('text-template').inputs.map((port: { id: string }) => port.id)).toEqual([
      'trigger',
      'context',
      'text',
    ]);
  });

  it('does not register or allow creating the removed data-filter node', () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const before = workspace.exportDocument();
    expect(registry.get('data-filter')).toBeUndefined();
    expect(() => workspace.addNode('data-filter', { x: 0, y: 0 })).toThrow('未注册的节点类型。');
    expect(workspace.exportDocument()).toBe(before);
  });

  it.each(['import', 'restore'])(
    'preserves removed nodes and edges on %s but blocks all execution',
    async (mode) => {
      const original = new Core.Workspace({ registry: createRegistry() });
      const start = original.addNode('start', { x: 0, y: 0 });
      const input = original.addNode('json-input', { x: 0, y: 300 });
      const template = original.addNode('text-template', { x: 350, y: 0 });
      const ai = original.addNode('ai-text', { x: 700, y: 0 });
      connect(original, [start, 'trigger', template, 'trigger']);
      connect(original, [input, 'data', template, 'context']);
      connect(original, [template, 'text', ai, 'prompt']);
      const document = JSON.parse(original.exportDocument());
      document.nodes.push({
        ...template,
        id: 'removed-filter',
        type: 'data-filter',
        config: { path: 'subject', operator: 'notEmpty', value: '', caseSensitive: false },
      });
      for (const edge of document.edges)
        if (edge.target.nodeId === template.id) edge.target.nodeId = 'removed-filter';
      document.edges.push({
        id: 'removed-filter-template',
        source: { nodeId: 'removed-filter', port: 'data' },
        target: { nodeId: template.id, port: 'context' },
      });
      const raw = JSON.stringify({ version: 1, activeId: document.id, documents: [document] });
      const storage = { getItem: vi.fn(() => (mode === 'restore' ? raw : null)), setItem: vi.fn() };
      const request = vi.fn();
      const readCredentials = vi.fn(() => CREDENTIALS);
      const workspace = new Core.Workspace({
        registry: createRegistry(),
        storage,
        services: createServices({ request, readCredentials }),
      });
      if (mode === 'import') workspace.importDocument(document);
      expect(workspace.storageProtected).toBe(false);
      expect(workspace.getDocument().nodes).toEqual(document.nodes);
      expect(workspace.getDocument().edges).toEqual(document.edges);
      const before = workspace.exportDocument();
      expect(JSON.parse(before).nodes).toEqual(document.nodes);
      expect(JSON.parse(before).edges).toEqual(document.edges);
      storage.setItem.mockClear();
      await expect(workspace.run()).rejects.toThrow('尚未安装');
      expect(request).not.toHaveBeenCalled();
      expect(readCredentials).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(workspace.exportDocument()).toBe(before);
      expect(workspace.getRuntime().status).toBe('idle');
    },
  );

  it('creates AI context defaults, fields and new nodes without any output token parameter', () => {
    const definition = latest('ai-text');
    expect(definition.version).toBe(2);
    expect(definition.defaults).toEqual({
      systemPrompt: '',
      contextWindowTokens: 100000,
      credentialRef: 'token-config',
    });
    expect(definition.fields.map((field: { key: string }) => field.key)).toEqual([
      'systemPrompt',
      'contextWindowTokens',
    ]);
    expect(
      definition.fields.find((field: { key: string }) => field.key === 'contextWindowTokens'),
    ).toMatchObject({
      label: '模型上下文（Token）',
      type: 'number',
      min: 4096,
      max: 1000000,
    });
    expect(Data.LIMITS).toMatchObject({
      aiDefaultContextWindowTokens: 100000,
      aiMinContextWindowTokens: 4096,
      aiMaxContextWindowTokens: 1000000,
    });
    expect(Data.LIMITS).not.toHaveProperty('maxTokens');
    expect(Data.LIMITS).not.toHaveProperty('defaultTokens');
    const workspace = new Core.Workspace({ registry: createRegistry() });
    expect(workspace.addNode('ai-text', { x: 0, y: 0 }).config).toEqual(definition.defaults);
    expect(workspace.exportDocument()).not.toMatch(
      /maxTokens|max_tokens|max_completion_tokens|max_output_tokens/,
    );
  });

  it.each([
    [
      'date-range',
      { period: 'custom', since: '2026-10-12', until: '2026-10-18' },
      {},
      { range: expect.objectContaining({ startDate: '2026-10-12', endDate: '2026-10-18' }) },
    ],
    ['json-input', { text: '[{"value":1}]' }, {}, { data: [{ value: 1 }] }],
    ['json-parse', {}, { text: '[false,null,1]' }, { data: [false, null, 1] }],
    [
      'json-pick',
      { path: 'context.values.0' },
      { context: { values: [['a', 'b']] } },
      { data: ['a', 'b'] },
    ],
    [
      'json-pick',
      { path: 'context.values' },
      { context: { values: [1, 2, 3] } },
      { data: [1, 2, 3] },
    ],
    ['json-pick', { path: 'context[1]' }, { context: [1, 2] }, { data: 2 }],
    ['json-pick', { path: 'context' }, { context: [1] }, { data: [1] }],
    [
      'json-pick',
      { path: 'context.context' },
      { context: { context: 'inner' } },
      { data: 'inner' },
    ],
    [
      'json-merge',
      { mode: 'object' },
      { a: [1], b: { x: 2 }, d: 'tail' },
      { data: { a: [1], b: { x: 2 }, d: 'tail' } },
    ],
    ['json-merge', { mode: 'concat' }, { a: [1, [2]], b: [], c: [3] }, { data: [1, [2], 3] }],
    [
      'text-template',
      { template: '{{text}} / {{context.name}} / {{context.list[0]}} / {{json:context.name}}' },
      { text: 'hello', context: { name: 'Alice', list: [42] } },
      { text: 'hello / Alice / 42 / "Alice"' },
    ],
    [
      'text-result',
      { format: 'text' },
      { text: 'plain <script> literal' },
      { text: 'plain <script> literal' },
    ],
    [
      'text-result',
      { format: 'json' },
      { data: { name: 'Alice', rows: [1, null] } },
      { text: '{\n  "name": "Alice",\n  "rows": [\n    1,\n    null\n  ]\n}' },
    ],
    ['text-result', { format: 'json' }, { data: 'plain string' }, { text: '"plain string"' }],
  ])(
    'executes the independent pure %s node using only supplied inputs/config',
    async (type, patch, inputs, expected) => {
      const definition = latest(type as string);
      await expect(
        Promise.resolve().then(() =>
          definition.execute({
            node: { config: config(type as string, patch as Record<string, unknown>) },
            inputs,
            services: {},
          }),
        ),
      ).resolves.toEqual(expected);
    },
  );

  it('preserves invalid JSON drafts until execution rather than blocking saves or imports', async () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const input = workspace.addNode('json-input', { x: 0, y: 0 });
    const draft = '{"secret-draft":';
    workspace.updateNode(input.id, { config: { text: draft } });
    const exported = workspace.exportDocument();
    expect(exported).toContain('secret-draft');
    expect(() => workspace.importDocument(exported)).not.toThrow();
    expect(() => registry.get('json-input').execute({ node: { config: { text: draft } } })).toThrow(
      '有效 JSON',
    );
  });

  it.each([
    ['github-commits', { range: RANGE }, 'githubCommits', [COMMIT], 'data'],
    ['ai-text', { prompt: 'explicit prompt' }, 'aiText', 'generic output', 'text'],
    [
      'feishu-find-row',
      { matches: [{ column: 'A', value: 'Alice', mode: 'equals' }] },
      'feishuFindRow',
      TARGET,
      'target',
    ],
    [
      'feishu-write-cells',
      { target: TARGET, values: [['one', 2]] },
      'feishuWriteCells',
      { range: 'C42:D42', updatedCells: 2, status: 'written' },
      'result',
    ],
  ])(
    'delegates only the %s capability to its injected service',
    async (type, inputs, method, output, port) => {
      const execute = vi.fn(async () => output);
      const signal = new AbortController().signal;
      const node = { config: config(type as string), name: '独立原子节点' };
      const suspend = vi.fn();
      const value = await latest(type as string).execute({
        node,
        inputs,
        services: { [method as string]: execute },
        signal,
        suspend,
      });
      expect(value).toEqual({ [port as string]: output });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith({
        config: node.config,
        ...(inputs as object),
        signal,
        ...(type === 'feishu-write-cells' ? { nodeName: node.name, suspend } : {}),
      });
    },
  );

  it.each([
    [
      'json-pick',
      { path: 'context.missing.path' },
      { context: { values: [] } },
      '不存在该字段路径',
    ],
    [
      'text-template',
      { template: '{{data}}' },
      { context: {} },
      '模板只支持 context、text 字段引用',
    ],
    ['json-merge', { mode: 'concat' }, { a: [1], b: { not: 'array' } }, '每个输入都是数组'],
    ['text-result', { format: 'json' }, {}, '只连接文本或 JSON 数据其中一个输入'],
    [
      'text-result',
      { format: 'json' },
      { text: 'a', data: {} },
      '只连接文本或 JSON 数据其中一个输入',
    ],
    [
      'text-result',
      { format: 'json' },
      { data: ['x'.repeat(Data.LIMITS.textLength)] },
      '格式化后的 JSON 超过 500000 字符',
    ],
  ])(
    'fails the pure %s node explicitly instead of filling defaults',
    (type, patch, inputs, message) => {
      expect(() =>
        latest(type as string).execute({
          node: { config: config(type as string, patch as Record<string, unknown>) },
          inputs,
        }),
      ).toThrow(message as string);
    },
  );

  it.each([
    ['json-pick', { path: '__proto__.x' }],
    ['json-pick', { path: 'context..b' }],
    ['json-pick', { path: 'data.values' }],
    ['json-pick', { path: 'values' }],
    ['json-pick', { path: '' }],
    ['json-merge', { mode: 'deep' }],
    ['feishu-write-cells', { maxRows: 0 }],
    ['feishu-write-cells', { maxRows: 201 }],
    ['feishu-write-cells', { expectedColumns: -1 }],
    ['feishu-write-cells', { expectedColumns: 1.5 }],
  ])('rejects invalid %s configuration %j', (type, patch) => {
    expect(
      latest(type as string).validateConfig(
        config(type as string, patch as Record<string, unknown>),
      ),
    ).not.toBeNull();
  });

  it('upgrades legacy AI and write nodes explicitly with behaviour-preserving migrations', () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const ai = workspace.addNode('ai-text', { x: 0, y: 0 });
    const writer = workspace.addNode('feishu-write-cells', { x: 400, y: 0 });
    const document = JSON.parse(workspace.exportDocument());
    Object.assign(document.nodes[0], {
      version: 1,
      config: { systemPrompt: 'legacy', credentialRef: 'token-config', maxTokens: 4096 },
    });
    Object.assign(document.nodes[1], {
      version: 1,
      config: { startColumn: 'D', credentialRef: 'token-config' },
    });
    const imported = workspace.importDocument(document);
    const [legacyAi, legacyWriter] = imported.nodes;
    expect(legacyAi.config).toHaveProperty('maxTokens', 4096);
    workspace.upgradeNode(legacyAi.id);
    workspace.upgradeNode(legacyWriter.id);
    const [nextAi, nextWriter] = workspace.getDocument().nodes;
    expect(nextAi).toMatchObject({
      version: 2,
      config: {
        systemPrompt: 'legacy',
        contextWindowTokens: 100000,
        credentialRef: 'token-config',
      },
    });
    expect(nextAi.config).not.toHaveProperty('maxTokens');
    expect(nextWriter).toMatchObject({
      version: 2,
      config: {
        startColumn: 'D',
        maxRows: Data.LIMITS.rows,
        expectedColumns: 0,
        credentialRef: 'token-config',
      },
    });
    expect(ai.version).toBe(2);
    expect(writer.version).toBe(2);
    expect(() => workspace.upgradeNode(nextAi.id)).toThrow('最新版本');
  });

  it.each([
    [1, 'values', 'context.values'],
    [1, '', 'context'],
    [1, '[0].name', 'context[0].name'],
    [2, 'data.values', 'context.values'],
    [2, 'data[0].name', 'context[0].name'],
  ])(
    'upgrades json-pick v%s path %j to the context-rooted path %j with the same result',
    (version, legacy, rooted) => {
      const workspace = new Core.Workspace({ registry: createRegistry() });
      const pick = workspace.addNode('json-pick', { x: 0, y: 0 });
      const document = JSON.parse(workspace.exportDocument());
      Object.assign(document.nodes[0], { version, config: { path: legacy } });
      const imported = workspace.importDocument(document);
      workspace.upgradeNode(imported.nodes[0].id);
      expect(workspace.getDocument().nodes[0]).toMatchObject({
        version: 3,
        config: { path: rooted },
      });
      const input = [{ name: 'first' }];
      const source = legacy.includes('values') ? { values: input } : input;
      expect(
        registry
          .get('json-pick', 3)
          .execute({ node: { config: { path: rooted } }, inputs: { context: source } }),
      ).toEqual(
        registry
          .get('json-pick', version)
          .execute({ node: { config: { path: legacy } }, inputs: { data: source } }),
      );
      expect(pick.version).toBe(3);
    },
  );

  it('upgrades a legacy template and json-pick together with their data input edges renamed to context', () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const input = workspace.addNode('json-input', { x: 0, y: 0 });
    const template = workspace.addNode('text-template', { x: 400, y: 0 });
    const pick = workspace.addNode('json-pick', { x: 400, y: 400 });
    const document = JSON.parse(workspace.exportDocument());
    Object.assign(document.nodes[1], {
      version: 1,
      config: { template: 'A {{data.a}} {{json:data}} {{text}}' },
    });
    Object.assign(document.nodes[2], { version: 2, config: { path: 'data.a' } });
    document.edges = [
      {
        id: 'to-template',
        source: { nodeId: input.id, port: 'data' },
        target: { nodeId: template.id, port: 'data' },
      },
      {
        id: 'to-pick',
        source: { nodeId: input.id, port: 'data' },
        target: { nodeId: pick.id, port: 'data' },
      },
    ];
    const imported = workspace.importDocument(document);
    for (const node of imported.nodes.slice(1)) workspace.upgradeNode(node.id);
    const upgraded = workspace.getDocument();
    expect(upgraded.nodes[1]).toMatchObject({
      version: 2,
      config: { template: 'A {{context.a}} {{json:context}} {{text}}' },
    });
    expect(upgraded.nodes[2]).toMatchObject({ version: 3, config: { path: 'context.a' } });
    expect(upgraded.edges.map((edge: { target: { port: string } }) => edge.target.port)).toEqual([
      'context',
      'context',
    ]);
  });

  it('refuses to upgrade a legacy template that uses both data and context without changing the document', () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    workspace.addNode('text-template', { x: 0, y: 0 });
    const document = JSON.parse(workspace.exportDocument());
    Object.assign(document.nodes[0], {
      version: 1,
      config: { template: '{{data}} {{context.startDate}}' },
    });
    const imported = workspace.importDocument(document);
    const before = workspace.exportDocument();
    expect(() => workspace.upgradeNode(imported.nodes[0].id)).toThrow('JSON 合并');
    expect(workspace.exportDocument()).toBe(before);
  });
});

describe('workflow controlled same-origin capability payloads', () => {
  it('sends four independent contracts and reconstructs only whitelisted success fields', async () => {
    const request = vi.fn(async (path: string, _options: RequestInit) => {
      if (path.endsWith('github-commits'))
        return response([
          { ...COMMIT, runtime: CREDENTIALS, apiKey: 'discarded-extra' },
          { ...COMMIT, isMerge: false },
        ]);
      if (path.endsWith('ai-text'))
        return response({ text: 'generic text', apiKey: 'discarded-extra' });
      if (path.endsWith('feishu-find-row'))
        return response({ ...TARGET, appSecret: 'discarded-extra' });
      return response({
        range: 'Z42:AA43',
        updatedCells: 4,
        status: 'written',
        runtime: CREDENTIALS,
      });
    });
    const confirmWrite = vi.fn(async () => true);
    const readCredentials = vi.fn(() => CREDENTIALS);
    const services = createServices({ request, readCredentials, confirmWrite });
    expect(readCredentials).not.toHaveBeenCalled();
    expect(
      await services.githubCommits({
        config: config('github-commits', { repository: 'owner/repo' }),
        range: RANGE,
      }),
    ).toEqual([COMMIT, { ...COMMIT, isMerge: false }]);
    expect(
      await services.aiText({
        config: config('ai-text', { systemPrompt: 'generic system' }),
        prompt: 'user-defined prompt',
      }),
    ).toBe('generic text');
    const matches = [{ column: 'A', value: 'Alice', mode: 'equals' }];
    expect(
      await services.feishuFindRow({
        config: config('feishu-find-row', { wikiUrl: WIKI }),
        matches,
      }),
    ).toEqual(TARGET);
    const values = [
      ['=literal-formula', 2],
      [true, null],
    ];
    expect(
      await services.feishuWriteCells({
        config: config('feishu-write-cells', { startColumn: 'Z', maxRows: 2 }),
        target: TARGET,
        values,
        nodeName: '目标写入',
      }),
    ).toEqual({ range: 'Z42:AA43', updatedCells: 4, status: 'written' });
    expect(readCredentials).toHaveBeenCalledTimes(4);
    expect(confirmWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        wikiUrl: WIKI,
        range: 'Z42:AA43',
        values,
        nodeName: '目标写入',
        signal: expect.any(AbortSignal),
      }),
    );
    const bodies = request.mock.calls.map(([path, options]) => {
      expect(path).toMatch(
        /^\/api\/workflow-capabilities\/(github-commits|ai-text|feishu-find-row|feishu-write-cells)$/,
      );
      expect(path).not.toMatch(/weekly|jobs/);
      expect(options).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        signal: expect.any(AbortSignal),
      });
      return JSON.parse(String(options.body));
    });
    expect(bodies).toEqual([
      {
        repository: 'owner/repo',
        branch: '',
        author: '',
        since: RANGE.since,
        until: RANGE.until,
        maxCommits: 100,
        runtime: { githubToken: CREDENTIALS.githubToken },
      },
      {
        prompt: 'user-defined prompt',
        systemPrompt: 'generic system',
        contextWindowTokens: 100000,
        runtime: { ai: { ...CREDENTIALS.ai, enableThinking: false } },
      },
      {
        wikiUrl: WIKI,
        range: 'A1:B200',
        matches,
        runtime: { appId: CREDENTIALS.feishuAppId, appSecret: CREDENTIALS.feishuAppSecret },
      },
      {
        wikiUrl: WIKI,
        range: 'Z42:AA43',
        values,
        confirmed: true,
        runtime: { appId: CREDENTIALS.feishuAppId, appSecret: CREDENTIALS.feishuAppSecret },
      },
    ]);
  });

  it('reads only the existing browser Token key at execution time and never writes credentials or confirmation state', async () => {
    const getItem = vi.fn(() => JSON.stringify(CREDENTIALS));
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    const services = createServices({ request: async () => response({ text: 'safe output' }) });
    expect(getItem).not.toHaveBeenCalled();
    await expect(
      services.aiText({ config: config('ai-text'), prompt: 'explicit prompt' }),
    ).resolves.toBe('safe output');
    expect(getItem).toHaveBeenCalledOnce();
    expect(getItem).toHaveBeenCalledWith('nestcloud:release-tokens:v1');
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([
    ['github', {}],
    ['github', { githubToken: '' }],
    ['ai', { ai: { baseUrl: CREDENTIALS.ai.baseUrl, apiKey: '', model: 'x' } }],
    ['ai', { ai: { baseUrl: '', apiKey: 'x', model: 'x' } }],
    ['ai', { ai: { baseUrl: CREDENTIALS.ai.baseUrl, apiKey: 'x', model: '' } }],
    ['find', { feishuAppId: 'x' }],
    ['find', { feishuAppSecret: 'x' }],
    ['write', {}],
    ['write', { feishuAppId: 'x' }],
  ])('validates complete %s credentials before issuing any request', async (kind, credentials) => {
    const request = vi.fn();
    const confirmWrite = vi.fn(async () => true);
    const services = createServices({ request, readCredentials: () => credentials, confirmWrite });
    const pending =
      kind === 'github'
        ? services.githubCommits({
            config: config('github-commits', { repository: 'owner/repo' }),
            range: RANGE,
          })
        : kind === 'ai'
          ? services.aiText({ config: config('ai-text'), prompt: 'explicit prompt' })
          : kind === 'find'
            ? services.feishuFindRow({
                config: config('feishu-find-row', { wikiUrl: WIKI }),
                matches: [{ column: 'A', value: 'x', mode: 'equals' }],
              })
            : services.feishuWriteCells({
                config: config('feishu-write-cells'),
                target: TARGET,
                values: [[1]],
              });
    await expect(pending).rejects.toThrow(/Token/);
    expect(request).not.toHaveBeenCalled();
    expect(confirmWrite).not.toHaveBeenCalled();
  });

  it.each([
    'https://localhost:8443/v1',
    'https://service.internal:9443/v1',
    'https://intranet/v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.1:8443/v1',
    'https://[::1]/v1',
    'https://[fd00::1]:9443/v1',
    'https://api.example.com:8443/v1/',
    'http://127.0.0.1:3000/v1',
    'https://user:pass@api.openai.com/v1',
    'https://api.openai.com/v1?apiKey=x',
    'https://api.openai.com/#fragment',
    'not a url',
  ])(
    'sends the configured AI address %s unchanged without preflight validation',
    async (baseUrl) => {
      const request = vi.fn(async (_path: string, _options: RequestInit) =>
        response({ text: 'generated text' }),
      );
      const ai = { ...CREDENTIALS.ai, baseUrl };
      const services = createServices({ request, readCredentials: () => ({ ...CREDENTIALS, ai }) });
      await expect(
        services.aiText({
          config: config('ai-text', { systemPrompt: 'system' }),
          prompt: 'explicit prompt',
        }),
      ).resolves.toBe('generated text');
      expect(request).toHaveBeenCalledOnce();
      const [path, options] = request.mock.calls[0];
      expect(path).toBe('/api/workflow-capabilities/ai-text');
      expect(options).toMatchObject({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      });
      expect(JSON.parse(String(options.body))).toEqual({
        prompt: 'explicit prompt',
        systemPrompt: 'system',
        contextWindowTokens: 100000,
        runtime: { ai: { ...ai, enableThinking: false } },
      });
    },
  );

  it.each(['wiki', 'sheets'])(
    'accepts bounded resource tokens with separators in %s links',
    async (resource) => {
      const wikiUrl = `https://team.feishu.cn/${resource}/test-node_01?sheet=sheet01`;
      const request = vi.fn(async () => response({ ...TARGET, wikiUrl }));
      const services = createServices({ request, readCredentials: () => CREDENTIALS });
      await expect(
        services.feishuFindRow({
          config: config('feishu-find-row', { wikiUrl }),
          matches: [{ column: 'B', value: 'Alice', mode: 'equals' }],
        }),
      ).resolves.toMatchObject({ wikiUrl });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects excess lookup conditions before issuing a request', async () => {
    const request = vi.fn();
    const services = createServices({ request, readCredentials: () => CREDENTIALS });
    const matches = Array.from({ length: Data.LIMITS.lookupMatches + 1 }, () => ({
      column: 'B',
      value: 'Alice',
      mode: 'equals',
    }));
    await expect(
      services.feishuFindRow({ config: config('feishu-find-row', { wikiUrl: WIKI }), matches }),
    ).rejects.toThrow('非空匹配条件数组');
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts a standard GitHub HTTPS repository and an explicit Feishu Sheets resource', async () => {
    const sheetUrl = 'https://team.larksuite.com/sheets/sheetToken?sheet=sheet01';
    const request = vi.fn(async (path: string) =>
      response(path.endsWith('github-commits') ? [] : { ...TARGET, wikiUrl: sheetUrl }),
    );
    const services = createServices({ request, readCredentials: () => CREDENTIALS });
    await expect(
      services.githubCommits({
        config: config('github-commits', { repository: 'https://github.com/owner/repo.git' }),
        range: RANGE,
      }),
    ).resolves.toEqual([]);
    await expect(
      services.feishuFindRow({
        config: config('feishu-find-row', { wikiUrl: sheetUrl }),
        matches: [{ column: 'B', value: '42', mode: 'contains' }],
      }),
    ).resolves.toMatchObject({ wikiUrl: sheetUrl });
  });

  it('rejects invalid execution inputs before reading credentials or sending any request', async () => {
    const request = vi.fn();
    const readCredentials = vi.fn(() => CREDENTIALS);
    const services = createServices({ request, readCredentials, confirmWrite: async () => true });
    const github = config('github-commits', { repository: 'owner/repo' });
    await expect(services.githubCommits({ config: github, range: {} })).rejects.toThrow(
      '完整的 ISO since 和 until',
    );
    await expect(
      services.githubCommits({
        config: github,
        range: { since: '2020-01-01T00:00:00Z', until: RANGE.until },
      }),
    ).rejects.toThrow('366');
    await expect(services.aiText({ config: config('ai-text'), prompt: '' })).rejects.toThrow(
      '提示词',
    );
    await expect(
      services.aiText({
        config: config('ai-text'),
        prompt: 'x'.repeat(Data.LIMITS.promptChars + 1),
      }),
    ).rejects.toThrow('200000');
    const find = config('feishu-find-row', { wikiUrl: WIKI });
    for (const { matches, message } of [
      { matches: [], message: '非空匹配条件数组' },
      {
        matches: [{ column: 'C', value: 'x', mode: 'equals' }],
        message: '匹配列必须位于明确的查找范围内',
      },
      { matches: [{ column: 'A', value: 42, mode: 'equals' }], message: '匹配条件必须仅包含' },
      { matches: [{ column: 'A', value: 'x', mode: 'regex' }], message: '匹配条件必须仅包含' },
      {
        matches: [{ column: 'A', value: 'x', mode: 'equals', hidden: true }],
        message: '匹配条件必须仅包含',
      },
    ])
      await expect(services.feishuFindRow({ config: find, matches })).rejects.toThrow(message);
    await expect(
      services.feishuWriteCells({
        config: config('feishu-write-cells'),
        target: { ...TARGET, runtime: CREDENTIALS },
        values: [[1]],
      }),
    ).rejects.toThrow('写入目标必须是明确的飞书 Wiki 和绝对行坐标');
    await expect(
      services.feishuWriteCells({
        config: config('feishu-write-cells'),
        target: TARGET,
        values: [[1], [2, 3]],
      }),
    ).rejects.toThrow('每一行的列数必须相同');
    expect(request).not.toHaveBeenCalled();
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it.each([4096, 65536, 100000, 1000000])(
    'preserves and explicitly sends contextWindowTokens=%s and rejects deprecated maxTokens on the current version',
    async (contextWindowTokens) => {
      const workspace = new Core.Workspace({ registry: createRegistry() });
      const ai = workspace.addNode('ai-text', { x: 0, y: 0 });
      expect(() =>
        workspace.updateNode(ai.id, {
          config: config('ai-text', { contextWindowTokens, maxTokens: 1 }),
        }),
      ).toThrow('未允许');
      const current = config('ai-text', { contextWindowTokens });
      workspace.updateNode(ai.id, { config: current });
      const exported = workspace.exportDocument();
      const restored = new Core.Workspace({ registry: createRegistry() });
      restored.importDocument(exported);
      const saved = restored.getDocument().nodes[0].config;
      expect(saved).toEqual(current);
      const request = vi.fn(async (_path: string, _options: RequestInit) =>
        response({ text: 'generated text' }),
      );
      const services = createServices({ request, readCredentials: () => CREDENTIALS });
      await expect(services.aiText({ config: saved, prompt: 'explicit prompt' })).resolves.toBe(
        'generated text',
      );
      expect(request).toHaveBeenCalledOnce();
      expect(JSON.parse(String(request.mock.calls[0][1].body))).toEqual({
        prompt: 'explicit prompt',
        systemPrompt: '',
        contextWindowTokens,
        runtime: { ai: { ...CREDENTIALS.ai, enableThinking: false } },
      });
      expect(saved).toEqual(current);
    },
  );

  it.each([
    ['true', true, true],
    ['false', false, false],
    ['missing', undefined, false],
    ['string true', 'true', false],
    ['number one', 1, false],
  ])(
    'sends enableThinking from stored AI credentials as a strict boolean (%s)',
    async (_name, stored, expected) => {
      const request = vi.fn(async (_path: string, _options: RequestInit) =>
        response({ text: 'generated text' }),
      );
      const ai = { ...CREDENTIALS.ai, ...(stored === undefined ? {} : { enableThinking: stored }) };
      const services = createServices({ request, readCredentials: () => ({ ...CREDENTIALS, ai }) });
      await expect(
        services.aiText({ config: config('ai-text'), prompt: 'explicit prompt' }),
      ).resolves.toBe('generated text');
      const body = JSON.parse(String(request.mock.calls[0][1].body));
      expect(body.runtime.ai).toEqual({ ...CREDENTIALS.ai, enableThinking: expected });
    },
  );

  it('does not treat enableThinking as a required credential field', async () => {
    const request = vi.fn(async (_path: string, _options: RequestInit) =>
      response({ text: 'generated text' }),
    );
    const services = createServices({
      request,
      readCredentials: () => ({ ...CREDENTIALS, ai: { ...CREDENTIALS.ai, enableThinking: false } }),
    });
    await expect(
      services.aiText({ config: config('ai-text'), prompt: 'explicit prompt' }),
    ).resolves.toBe('generated text');
  });

  it('rejects an own undefined context before execution instead of treating it as a missing legacy field', async () => {
    const current = config('ai-text', { contextWindowTokens: undefined });
    expect(registry.get('ai-text').validateConfig(current)).not.toBeNull();
    const request = vi.fn();
    const readCredentials = vi.fn(() => CREDENTIALS);
    await expect(
      createServices({ request, readCredentials }).aiText({
        config: current,
        prompt: 'explicit prompt',
      }),
    ).rejects.toThrow('配置');
    expect(request).not.toHaveBeenCalled();
    expect(readCredentials).not.toHaveBeenCalled();
    // JSON 草稿无法包含 undefined；旧配置真正缺键的恢复/导出由下方回归覆盖。
    expect(Object.hasOwn(current, 'contextWindowTokens')).toBe(true);
  });

  it.each([
    4095,
    1000001,
    0,
    -1,
    4096.5,
    '100000',
    '',
    null,
    true,
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])(
    'rejects an explicitly invalid contextWindowTokens=%s before credentials, import or requests',
    async (contextWindowTokens) => {
      const current = config('ai-text', { contextWindowTokens, maxTokens: 100000 });
      expect(registry.get('ai-text').validateConfig(current)).not.toBeNull();
      const request = vi.fn();
      const readCredentials = vi.fn(() => CREDENTIALS);
      await expect(
        createServices({ request, readCredentials }).aiText({
          config: current,
          prompt: 'explicit prompt',
        }),
      ).rejects.toThrow('配置');
      expect(request).not.toHaveBeenCalled();
      expect(readCredentials).not.toHaveBeenCalled();
      const workspace = new Core.Workspace({ registry: createRegistry() });
      workspace.addNode('ai-text', { x: 0, y: 0 });
      const before = workspace.exportDocument();
      const document = JSON.parse(before);
      document.nodes[0].config = current;
      expect(() => workspace.importDocument(document)).toThrow('配置');
      expect(workspace.exportDocument()).toBe(before);
    },
  );

  it.each([undefined, 4096, 8193, Number.MAX_SAFE_INTEGER, 1e100])(
    'imports and restores legacy AI maxTokens=%s without protection, rewrites or execution propagation',
    async (maxTokens) => {
      const original = new Core.Workspace({ registry: createRegistry() });
      const start = original.addNode('start', { x: 0, y: 0 });
      const prompt = original.addNode('text', { x: 0, y: 300 });
      original.updateNode(prompt.id, { config: { text: 'legacy prompt' } });
      const ai = original.addNode('ai-text', { x: 350, y: 0 });
      connect(original, [start, 'trigger', ai, 'trigger']);
      connect(original, [prompt, 'text', ai, 'prompt']);
      const document = JSON.parse(original.exportDocument());
      const legacyConfig = {
        systemPrompt: 'legacy system',
        credentialRef: 'token-config',
        ...(maxTokens === undefined ? {} : { maxTokens }),
      };
      Object.assign(
        document.nodes.find((node: { id: string }) => node.id === ai.id),
        { version: 1, config: legacyConfig },
      );
      const imported = new Core.Workspace({ registry: createRegistry() });
      expect(() => imported.importDocument(JSON.stringify(document))).not.toThrow();
      expect(
        imported.getDocument().nodes.find((node: { id: string }) => node.id === ai.id).config,
      ).toEqual(legacyConfig);

      const raw = JSON.stringify(
        { version: 1, activeId: document.id, documents: [document] },
        null,
        2,
      );
      const storage = { getItem: vi.fn((_key: string) => raw), setItem: vi.fn() };
      const onStorageError = vi.fn();
      const request = vi.fn(async (_path: string, _options: RequestInit) =>
        response({ text: 'legacy output' }),
      );
      const restored = new Core.Workspace({
        registry: createRegistry(),
        storage,
        onStorageError,
        services: createServices({ request, readCredentials: () => CREDENTIALS }),
      });
      expect(restored.storageProtected).toBe(false);
      expect(restored.storageError).toBe('');
      expect(onStorageError).not.toHaveBeenCalled();
      expect(storage.getItem).toHaveBeenCalledWith(Core.STORAGE_KEY);
      const before = restored.exportDocument();
      expect(
        restored.getDocument().nodes.find((node: { id: string }) => node.id === ai.id).config,
      ).toEqual(legacyConfig);
      await expect(restored.run()).resolves.toMatchObject({ status: 'succeeded' });
      expect(restored.getRuntime().states.get(ai.id).outputs).toEqual({ text: 'legacy output' });
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0][0]).toBe('/api/workflow-capabilities/ai-text');
      const body = JSON.parse(String(request.mock.calls[0][1].body));
      expect(body).toEqual({
        prompt: 'legacy prompt',
        systemPrompt: 'legacy system',
        contextWindowTokens: 100000,
        runtime: { ai: { ...CREDENTIALS.ai, enableThinking: false } },
      });
      for (const key of ['maxTokens', 'max_tokens', 'max_completion_tokens', 'max_output_tokens'])
        expect(body).not.toHaveProperty(key);
      expect(restored.exportDocument()).toBe(before);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem(Core.STORAGE_KEY)).toBe(raw);
    },
  );

  it.each([0, -1, 1.5])(
    'legacy AI v1 ignores deprecated maxTokens=%s instead of applying numeric constraints',
    async (maxTokens) => {
      const current = config('ai-text', { maxTokens });
      const legacy = registry.get('ai-text', 1);
      expect(legacy.validateConfig(current)).toBeNull();
      const request = vi.fn(async (_path: string, _options: RequestInit) =>
        response({ text: 'generated text' }),
      );
      const services = createServices({ request, readCredentials: () => CREDENTIALS });
      await expect(
        legacy.execute({
          node: { config: current },
          inputs: { prompt: 'explicit prompt' },
          services,
        }),
      ).resolves.toEqual({ text: 'generated text' });
      expect(JSON.parse(String(request.mock.calls[0][1].body))).toEqual({
        prompt: 'explicit prompt',
        systemPrompt: '',
        contextWindowTokens: 100000,
        runtime: { ai: { ...CREDENTIALS.ai, enableThinking: false } },
      });
      expect(current.maxTokens).toBe(maxTokens);
    },
  );

  it.each([
    ['github-commits', { repository: 'https://evil.example/owner/repo' }],
    ['github-commits', { repository: 'https://user:secret@github.com/owner/repo' }],
    ['github-commits', { repository: 'https://github.com/owner/repo?token=x' }],
    ['github-commits', { maxCommits: 501 }],
    ['github-commits', { maxTokens: 4096 }],
    ['ai-text', { systemPrompt: 'x'.repeat(Data.LIMITS.systemPromptChars + 1) }],
    ['ai-text', { systemPrompt: 1e100, maxTokens: 1e100 }],
    ['ai-text', { credentialRef: 'other-store', maxTokens: 1e100 }],
    ['feishu-find-row', { wikiUrl: 'https://evil.example/wiki/doc?sheet=x' }],
    ['feishu-find-row', { wikiUrl: 'https://team.feishu.cn/wiki/doc' }],
    ['feishu-find-row', { wikiUrl: WIKI + '#fragment' }],
    ['feishu-find-row', { range: 'A1:B501' }],
    ['feishu-find-row', { range: 'A1:AY2' }],
    ['feishu-find-row', { range: 'A1:AX201' }],
    ['feishu-write-cells', { startColumn: 'AAA' }],
  ])('rejects invalid registered %s configuration %j', (type, patch) => {
    expect(
      registry.get(type).validateConfig(config(type as string, patch as Record<string, unknown>)),
    ).not.toBeNull();
  });

  it.each([
    'unknown',
    'payload',
    'credentials',
    'max_tokens',
    'max_completion_tokens',
    'max_output_tokens',
  ])('still rejects AI extra %s keys even alongside deprecated maxTokens', async (key) => {
    const request = vi.fn();
    const readCredentials = vi.fn(() => CREDENTIALS);
    const services = createServices({ request, readCredentials });
    const current = config('ai-text', { maxTokens: 1e100, [key]: 'not-allowed' });
    expect(registry.get('ai-text').validateConfig(current)).toContain('未允许');
    await expect(services.aiText({ config: current, prompt: 'explicit prompt' })).rejects.toThrow(
      '未允许',
    );
    expect(request).not.toHaveBeenCalled();
    expect(readCredentials).not.toHaveBeenCalled();
    const workspace = new Core.Workspace({ registry: createRegistry() });
    workspace.addNode('ai-text', { x: 0, y: 0 });
    const before = workspace.exportDocument();
    const document = JSON.parse(before);
    document.nodes[0].config = current;
    expect(() => workspace.importDocument(document)).toThrow('未允许');
    expect(workspace.exportDocument()).toBe(before);
  });

  it('atomically rejects imported remote secrets, arbitrary endpoints and durable confirmations', () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    for (const type of ['github-commits', 'ai-text', 'feishu-find-row', 'feishu-write-cells'])
      workspace.addNode(type, { x: 0, y: 0 });
    const before = workspace.exportDocument();
    for (let index = 0; index < 4; index += 1) {
      for (const addition of [
        { token: 'private-import-secret' },
        { apiKey: 'private-import-secret' },
        { appSecret: 'private-import-secret' },
        { runtime: CREDENTIALS },
        { url: 'https://evil.example' },
        { confirmed: true },
        { credentialRef: 'other-store' },
      ]) {
        const imported = JSON.parse(before);
        Object.assign(imported.nodes[index].config, addition);
        expect(() => workspace.importDocument(imported)).toThrow(
          /节点配置包含缺失或未允许的字段|凭据引用只能是 token-config/,
        );
        expect(workspace.exportDocument()).toBe(before);
      }
    }
    expect(before).not.toContain('private-');
    expect(before).not.toContain('confirmed');
  });

  it.each([
    [404, '指定范围内没有匹配的行。', '能力请求失败：指定范围内没有匹配的行。'],
    [
      409,
      '指定范围内匹配到多行，无法唯一确定目标。',
      '能力请求失败：指定范围内匹配到多行，无法唯一确定目标。',
    ],
    [404, '', '能力请求失败，请检查参数、凭据或稍后重试。'],
    [500, 'x'.repeat(201), '能力请求失败，请检查参数、凭据或稍后重试。'],
    [401, `bad ${CREDENTIALS.feishuAppSecret}`, '能力请求失败，请检查参数、凭据或稍后重试。'],
  ])(
    'shows the controlled server message for a %s lookup failure only when it is short and secret-free',
    async (status, message, expected) => {
      const request = vi.fn(async () => ({
        ok: false,
        status,
        json: async () => ({ code: status, message, data: null }),
      }));
      const services = createServices({ request, readCredentials: () => CREDENTIALS });
      const error = await services
        .feishuFindRow({
          config: config('feishu-find-row', { wikiUrl: WIKI }),
          matches: [{ column: 'A', value: 'Alice', mode: 'equals' }],
        })
        .catch((failure: Error) => failure);
      expect(error.message).toBe(expected);
    },
  );

  it('never propagates raw credential-reader, network, parser or server error contents', async () => {
    const secret = CREDENTIALS.ai.apiKey;
    for (const options of [
      {
        readCredentials: () => {
          throw new Error(secret);
        },
        request: vi.fn(),
      },
      {
        request: async () => {
          throw new Error(secret);
        },
      },
      {
        request: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError(secret);
          },
        }),
      },
      {
        request: async () => ({
          ok: false,
          status: 500,
          json: async () => ({ code: 500, message: secret, data: { text: secret } }),
        }),
      },
      { request: async () => response({ text: secret }) },
    ]) {
      const services = createServices({ readCredentials: () => CREDENTIALS, ...options });
      const error = await services
        .aiText({ config: config('ai-text'), prompt: 'generic' })
        .catch((failure: Error) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(secret);
      expect(error.stack).not.toContain(secret);
    }
  });

  it.each([
    ['github', [{ ...COMMIT, isMerge: 'yes' }]],
    ['github', [{ ...COMMIT, date: 'not-date' }]],
    ['github', Array.from({ length: 101 }, () => COMMIT)],
    ['ai', { text: { generated: 'not-text' } }],
    ['find', { ...TARGET, row: 201 }],
    ['find', { ...TARGET, wikiUrl: WIKI.replace('team.', 'another.') }],
    ['find', { ...TARGET, sheetId: '' }],
    ['write', { range: 'C42:C42', status: 'written', updatedCells: 0 }],
    ['write', { range: 'D42:D42', status: 'written', updatedCells: 1 }],
    ['write', { range: 'C42:C42', status: 'failed', updatedCells: 1 }],
  ])(
    'rejects malformed successful %s payloads instead of distributing them',
    async (kind, data) => {
      const services = createServices({
        request: async () => response(data),
        readCredentials: () => CREDENTIALS,
        confirmWrite: async () => true,
      });
      const pending =
        kind === 'github'
          ? services.githubCommits({
              config: config('github-commits', { repository: 'owner/repo' }),
              range: RANGE,
            })
          : kind === 'ai'
            ? services.aiText({ config: config('ai-text'), prompt: 'prompt' })
            : kind === 'find'
              ? services.feishuFindRow({
                  config: config('feishu-find-row', { wikiUrl: WIKI }),
                  matches: [{ column: 'A', value: 'x', mode: 'equals' }],
                })
              : services.feishuWriteCells({
                  config: config('feishu-write-cells'),
                  target: TARGET,
                  values: [[1]],
                });
      await expect(pending).rejects.toThrow(
        /GitHub 服务返回了无效提交|AI 服务没有返回有效的文本结果|飞书服务返回了无效的目标坐标|飞书服务返回了无效的写入结果/,
      );
    },
  );

  it('supports literal skipped write results without retrying the remote operation', async () => {
    const request = vi.fn(async () =>
      response({ range: 'C42:C42', status: 'skipped', updatedCells: 0 }),
    );
    const services = createServices({
      request,
      readCredentials: () => CREDENTIALS,
      confirmWrite: async () => true,
    });
    await expect(
      services.feishuWriteCells({
        config: config('feishu-write-cells'),
        target: TARGET,
        values: [['=literal']],
      }),
    ).resolves.toEqual({ range: 'C42:C42', updatedCells: 0, status: 'skipped' });
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('workflow per-call write confirmation snapshots', () => {
  it('confirms a frozen real target and full matrix on every run, then sends that exact snapshot', async () => {
    const accepted = deferred<boolean>();
    const confirmWrite = vi.fn((_confirmation: unknown) => accepted.promise);
    const request = vi.fn(async (_path: string, _options: RequestInit) =>
      response({ range: 'Z42:AA43', updatedCells: 4, status: 'written' }),
    );
    const services = createServices({ request, readCredentials: () => CREDENTIALS, confirmWrite });
    const destination = { ...TARGET };
    const values = [
      ['first', 'second'],
      ['third', 'fourth'],
    ];
    const writerConfig = config('feishu-write-cells', { startColumn: 'Z', maxRows: 2 });
    const pending = services.feishuWriteCells({
      config: writerConfig,
      target: destination,
      values,
      nodeName: '本次写入',
    });
    destination.row = 99;
    values[0][0] = 'late-mutation';
    writerConfig.startColumn = 'A';
    await flushMicrotasks();
    expect(request).not.toHaveBeenCalled();
    expect(confirmWrite).toHaveBeenCalledOnce();
    const confirmation = confirmWrite.mock.calls[0][0] as unknown as {
      wikiUrl: string;
      range: string;
      values: string[][];
      nodeName: string;
    };
    expect(confirmation).toMatchObject({
      wikiUrl: WIKI,
      range: 'Z42:AA43',
      values: [
        ['first', 'second'],
        ['third', 'fourth'],
      ],
      nodeName: '本次写入',
    });
    expect(Object.isFrozen(confirmation)).toBe(true);
    expect(Object.isFrozen(confirmation.values)).toBe(true);
    expect(Object.isFrozen(confirmation.values[0])).toBe(true);
    expect(JSON.stringify(confirmation)).not.toContain('private-');
    accepted.resolve(true);
    await pending;
    const body = JSON.parse(String(request.mock.calls[0][1].body));
    expect(body).toMatchObject({
      wikiUrl: confirmation.wikiUrl,
      range: confirmation.range,
      values: confirmation.values,
      confirmed: true,
    });
    await services.feishuWriteCells({
      config: config('feishu-write-cells', { startColumn: 'Z', maxRows: 2 }),
      target: TARGET,
      values: [
        ['first', 'second'],
        ['third', 'fourth'],
      ],
    });
    expect(confirmWrite).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, async () => false, async () => 'true'])(
    'refuses a missing or non-boolean positive confirmation',
    async (confirmWrite) => {
      const request = vi.fn();
      const services = createServices({
        request,
        readCredentials: () => CREDENTIALS,
        confirmWrite,
      });
      await expect(
        services.feishuWriteCells({
          config: config('feishu-write-cells'),
          target: TARGET,
          values: [[1]],
        }),
      ).rejects.toThrow('确认');
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('stops while confirmation ignores its signal and never issues a late write after acceptance', async () => {
    const accepted = deferred<boolean>();
    const confirmWrite = vi.fn((_confirmation: unknown) => accepted.promise);
    const request = vi.fn();
    const controller = new AbortController();
    const services = createServices({ request, readCredentials: () => CREDENTIALS, confirmWrite });
    const pending = services.feishuWriteCells({
      config: config('feishu-write-cells'),
      target: TARGET,
      values: [[1]],
      signal: controller.signal,
    });
    const outcome = pending.catch((error: Error) => error);
    await flushMicrotasks();
    controller.abort();
    const error = await outcome;
    expect(error.message).toContain('停止');
    expect(error.message).not.toContain('已经写入');
    accepted.resolve(true);
    await flushMicrotasks();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not accept an imported confirmed:true even if a host confirmation callback exists', async () => {
    const request = vi.fn();
    const confirmWrite = vi.fn(async () => true);
    const services = createServices({ request, readCredentials: () => CREDENTIALS, confirmWrite });
    await expect(
      services.feishuWriteCells({
        config: config('feishu-write-cells', { confirmed: true }),
        target: TARGET,
        values: [[1]],
      }),
    ).rejects.toThrow('未允许');
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('warns that a submitted write may already have succeeded after network error and never retries', async () => {
    const request = vi.fn(async () => {
      throw new Error(CREDENTIALS.feishuAppSecret);
    });
    const services = createServices({
      request,
      readCredentials: () => CREDENTIALS,
      confirmWrite: async () => true,
    });
    const error = await services
      .feishuWriteCells({ config: config('feishu-write-cells'), target: TARGET, values: [[1]] })
      .catch((failure: Error) => failure);
    expect(error.message).toContain('远端可能已经写入，请核实后再重试');
    expect(error.message).not.toContain(CREDENTIALS.feishuAppSecret);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('workflow capability full-lifecycle timeout and late isolation', () => {
  it('does not read credentials or request for an already stopped signal', async () => {
    const request = vi.fn();
    const readCredentials = vi.fn(() => CREDENTIALS);
    const controller = new AbortController();
    controller.abort();
    const services = createServices({ request, readCredentials });
    await expect(
      services.aiText({ config: config('ai-text'), prompt: 'x', signal: controller.signal }),
    ).rejects.toThrow('停止');
    expect(readCredentials).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('still times out non-AI requests that ignore AbortSignal and never settle', async () => {
    vi.useFakeTimers();
    const request = vi.fn((_path: string, _options: RequestInit) => new Promise(() => {}));
    const services = createServices({
      request,
      readCredentials: () => CREDENTIALS,
      timeoutMs: 100,
    });
    const outcome = services
      .githubCommits({
        config: config('github-commits', { repository: 'owner/repo' }),
        range: RANGE,
      })
      .catch((error: Error) => error);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    expect((await outcome).message).toContain('超时');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it('waits without an AI deadline across credentials, request and response body', async () => {
    vi.useFakeTimers();
    const credentials = deferred<unknown>();
    const reply = deferred<unknown>();
    const body = deferred<unknown>();
    const request = vi.fn((_path: string, _options: RequestInit) => reply.promise);
    const services = createServices({
      request,
      readCredentials: () => credentials.promise,
      timeoutMs: 100,
    });
    let settled = false;
    const pending = services
      .aiText({ config: config('ai-text'), prompt: 'x' })
      .then((value: string) => {
        settled = true;
        return value;
      });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(settled).toBe(false);
    expect(request).not.toHaveBeenCalled();
    credentials.resolve(CREDENTIALS);
    await flushMicrotasks();
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(settled).toBe(false);
    expect(request.mock.calls[0][1].signal?.aborted).toBe(false);
    reply.resolve({ ok: true, status: 200, json: () => body.promise });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    body.resolve({ code: 200, data: { text: 'slow AI response' } });
    await expect(pending).resolves.toBe('slow AI response');
  });

  it('can still stop an unlimited AI response read and reject late output', async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const request = vi.fn(async (_path: string, _options: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => body.promise,
    }));
    const controller = new AbortController();
    const services = createServices({ request, readCredentials: () => CREDENTIALS });
    let settled = false;
    const pending = services
      .aiText({ config: config('ai-text'), prompt: 'x', signal: controller.signal })
      .catch((error: Error) => {
        settled = true;
        return error;
      });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(settled).toBe(false);
    expect(request.mock.calls[0][1].signal?.aborted).toBe(false);
    controller.abort();
    const stopped = await pending;
    expect(stopped).toBeInstanceOf(Error);
    expect(stopped.message).toContain('停止');
    expect(request.mock.calls[0][1].signal?.aborted).toBe(true);
    body.resolve({ code: 200, data: { text: 'late output' } });
    await flushMicrotasks();
    expect(await pending).toBe(stopped);
  });

  it('includes ignored credential promises in the same total timeout and prevents late requests', async () => {
    vi.useFakeTimers();
    const lateCredentials = deferred<unknown>();
    const request = vi.fn();
    const confirmWrite = vi.fn(async () => true);
    const services = createServices({
      request,
      timeoutMs: 100,
      readCredentials: () => lateCredentials.promise,
      confirmWrite,
    });
    const outcome = services
      .feishuWriteCells({ config: config('feishu-write-cells'), target: TARGET, values: [[1]] })
      .catch((error: Error) => error);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    expect((await outcome).message).toContain('超时');
    lateCredentials.resolve(CREDENTIALS);
    await flushMicrotasks();
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not count human confirmation time toward the request timeout and restarts it for the write request', async () => {
    vi.useFakeTimers();
    const accepted = deferred<boolean>();
    const reply = deferred<unknown>();
    const request = vi.fn((_path: string, _options: RequestInit) => reply.promise);
    const suspend = vi.fn((work: () => Promise<unknown>) => work());
    const services = createServices({
      request,
      timeoutMs: 100,
      readCredentials: () => CREDENTIALS,
      confirmWrite: () => accepted.promise,
    });
    const outcome = services
      .feishuWriteCells({
        config: config('feishu-write-cells'),
        target: TARGET,
        values: [[1]],
        suspend,
      })
      .catch((error: Error) => error);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(suspend).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    accepted.resolve(true);
    await flushMicrotasks();
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    const error = await outcome;
    expect(error.message).toContain('超时');
    expect(error.message).toContain('远端可能已经写入');
  });

  it.each([
    [{ maxRows: 1 }, [[1], [2]], '超过节点允许的 1 行'],
    [{ expectedColumns: 5 }, [[1, 2, 3, 4]], '与节点要求的 5 列不一致'],
  ])(
    'rejects matrices outside configured write limits %j before credentials or confirmation',
    async (patch, values, message) => {
      const request = vi.fn();
      const readCredentials = vi.fn(() => CREDENTIALS);
      const confirmWrite = vi.fn(async () => true);
      const services = createServices({ request, readCredentials, confirmWrite });
      await expect(
        services.feishuWriteCells({
          config: config('feishu-write-cells', patch),
          target: TARGET,
          values,
        }),
      ).rejects.toThrow(message);
      expect(readCredentials).not.toHaveBeenCalled();
      expect(confirmWrite).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('cancels response parsing even when the body ignores its signal, discarding its late data', async () => {
    const late = deferred<unknown>();
    const request = vi.fn(async () => ({ ok: true, status: 200, json: () => late.promise }));
    const controller = new AbortController();
    const services = createServices({ request, readCredentials: () => CREDENTIALS });
    const outcome = services
      .aiText({ config: config('ai-text'), prompt: 'x', signal: controller.signal })
      .catch((error: Error) => error);
    await flushMicrotasks();
    controller.abort();
    expect((await outcome).message).toContain('停止');
    late.resolve({ code: 200, data: { text: 'late-private-response' } });
    await flushMicrotasks();
  });

  it('times out while reading the body of an already submitted write with an uncertainty warning', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    }));
    const services = createServices({
      request,
      readCredentials: () => CREDENTIALS,
      confirmWrite: async () => true,
      timeoutMs: 100,
    });
    const outcome = services
      .feishuWriteCells({ config: config('feishu-write-cells'), target: TARGET, values: [[1]] })
      .catch((error: Error) => error);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    expect((await outcome).message).toContain('远端可能已经写入，请核实后再重试');
    expect(request).toHaveBeenCalledOnce();
  });

  it('bounds actual response bytes instead of trusting a success envelope or declared length', async () => {
    const services = createServices({
      readCredentials: () => CREDENTIALS,
      request: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({ code: 200, data: { text: 'x'.repeat(Data.LIMITS.responseBytes) } }),
      }),
    });
    await expect(services.aiText({ config: config('ai-text'), prompt: 'x' })).rejects.toThrow(
      '大小',
    );
  });
});

describe('workflow atomic real entry-to-result data flow', () => {
  it('runs start -> template with passive text -> text-result and start -> JSON parse independently', async () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const start = workspace.addNode('start', { x: 0, y: 0 });
    const source = workspace.addNode('text', { x: 0, y: 300 });
    workspace.updateNode(source.id, { config: { text: '[{"name":"Alice"},{"name":"Bob"}]' } });
    const template = workspace.addNode('text-template', { x: 350, y: 0 });
    workspace.updateNode(template.id, { config: { template: '输入原文：{{text}}' } });
    const result = workspace.addNode('text-result', { x: 700, y: 0 });
    const parser = workspace.addNode('json-parse', { x: 350, y: 350 });
    connect(workspace, [start, 'trigger', template, 'trigger']);
    connect(workspace, [source, 'text', template, 'text']);
    connect(workspace, [template, 'text', result, 'text']);
    connect(workspace, [start, 'trigger', parser, 'trigger']);
    connect(workspace, [source, 'text', parser, 'text']);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(workspace.getRuntime().states.get(result.id).outputs).toEqual({
      text: '输入原文：[{"name":"Alice"},{"name":"Bob"}]',
    });
    expect(workspace.getRuntime().states.get(parser.id).outputs).toEqual({
      data: [{ name: 'Alice' }, { name: 'Bob' }],
    });
    expect(Object.isFrozen(workspace.getRuntime().states.get(parser.id).outputs.data)).toBe(true);
  });

  it('composes raw retrieval, template, AI and text display with passive date/context data', async () => {
    const request = vi.fn(async (path: string) =>
      response(
        path.endsWith('github-commits')
          ? [COMMIT, { ...COMMIT, author: 'Bob' }]
          : { text: 'generated report text' },
      ),
    );
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) || null,
      setItem: (key: string, value: string) => saved.set(key, value),
    };
    const workspace = new Core.Workspace({
      registry: createRegistry(),
      services: createServices({ request, readCredentials: () => CREDENTIALS }),
      storage,
    });
    const start = workspace.addNode('start', { x: 0, y: 0 });
    const dates = workspace.addNode('date-range', { x: 0, y: 300 });
    workspace.updateNode(dates.id, {
      config: { period: 'custom', since: '2026-10-12', until: '2026-10-18' },
    });
    const github = workspace.addNode('github-commits', { x: 350, y: 0 });
    workspace.updateNode(github.id, {
      config: config('github-commits', { repository: 'owner/repo' }),
    });
    const template = workspace.addNode('text-template', { x: 1050, y: 0 });
    workspace.updateNode(template.id, {
      config: { template: 'Date {{context.b.startDate}}: {{context.a}}' },
    });
    const merge = workspace.addNode('json-merge', { x: 700, y: 0 });
    const ai = workspace.addNode('ai-text', { x: 1400, y: 0 });
    const output = workspace.addNode('text-result', { x: 1750, y: 0 });
    connect(workspace, [start, 'trigger', github, 'trigger']);
    connect(workspace, [dates, 'range', github, 'range']);
    connect(workspace, [github, 'data', merge, 'a']);
    connect(workspace, [dates, 'range', merge, 'b']);
    connect(workspace, [merge, 'data', template, 'context']);
    connect(workspace, [template, 'text', ai, 'prompt']);
    connect(workspace, [ai, 'text', output, 'text']);
    const before = workspace.exportDocument();
    expect(request).not.toHaveBeenCalled();
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    const states = workspace.getRuntime().states;
    expect(states.get(github.id).outputs.data).toHaveLength(2);
    expect(states.get(template.id).outputs.text).toContain(
      JSON.stringify([COMMIT, { ...COMMIT, author: 'Bob' }]),
    );
    expect(states.get(output.id).outputs).toEqual({ text: 'generated report text' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(workspace.exportDocument()).toBe(before);
    expect(saved.get(Core.STORAGE_KEY)).not.toContain('private-');
    expect(saved.get(Core.STORAGE_KEY)).not.toContain('generated report text');
    expect(saved.get(Core.STORAGE_KEY)).not.toContain('outputs');
  });

  it('runs JSON-input -> template from an explicit trigger and rejects mismatched data/control types atomically', async () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const start = workspace.addNode('start', { x: 0, y: 0 });
    const input = workspace.addNode('json-input', { x: 0, y: 300 });
    workspace.updateNode(input.id, { config: { text: '[1,2,3]' } });
    const template = workspace.addNode('text-template', { x: 350, y: 0 });
    const parser = workspace.addNode('json-parse', { x: 700, y: 0 });
    const ai = workspace.addNode('ai-text', { x: 1050, y: 0 });
    connect(workspace, [start, 'trigger', template, 'trigger']);
    connect(workspace, [input, 'data', template, 'context']);
    const before = workspace.exportDocument();
    expect(() => connect(workspace, [input, 'data', parser, 'text'])).toThrow('类型');
    expect(() => connect(workspace, [start, 'trigger', ai, 'prompt'])).toThrow('类型');
    expect(() => connect(workspace, [input, 'data', template, 'trigger'])).toThrow('类型');
    expect(workspace.exportDocument()).toBe(before);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(workspace.getRuntime().states.get(template.id).outputs).toEqual({ text: '[1,2,3]' });
    expect(workspace.getRuntime().states.get(parser.id).status).toBe('skipped');
  });

  it('composes independent row lookup and cell writing with explicit JSON sources and per-run confirmation', async () => {
    const request = vi.fn(async (path: string) =>
      response(
        path.endsWith('feishu-find-row')
          ? TARGET
          : { range: 'Z42:AA43', updatedCells: 4, status: 'written' },
      ),
    );
    const confirmWrite = vi.fn(async (_confirmation: unknown) => true);
    const workspace = new Core.Workspace({
      registry: createRegistry(),
      services: createServices({ request, readCredentials: () => CREDENTIALS, confirmWrite }),
    });
    const start = workspace.addNode('start', { x: 0, y: 0 });
    const matches = workspace.addNode('json-input', { x: 0, y: 300 });
    workspace.updateNode(matches.id, {
      config: { text: '[{"column":"B","value":"Alice","mode":"equals"}]' },
    });
    const values = workspace.addNode('json-input', { x: 0, y: 600 });
    workspace.updateNode(values.id, {
      config: { text: '[["Monday","Tuesday"],["=literal",null]]' },
    });
    const lookup = workspace.addNode('feishu-find-row', { x: 350, y: 0 });
    workspace.updateNode(lookup.id, { config: config('feishu-find-row', { wikiUrl: WIKI }) });
    const writer = workspace.addNode('feishu-write-cells', { x: 700, y: 0 });
    workspace.updateNode(writer.id, {
      config: config('feishu-write-cells', { startColumn: 'Z', maxRows: 2 }),
    });
    connect(workspace, [start, 'trigger', lookup, 'trigger']);
    connect(workspace, [matches, 'data', lookup, 'matches']);
    connect(workspace, [lookup, 'target', writer, 'target']);
    connect(workspace, [values, 'data', writer, 'values']);
    const before = workspace.exportDocument();
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(workspace.getRuntime().states.get(writer.id).outputs).toEqual({
      result: { range: 'Z42:AA43', updatedCells: 4, status: 'written' },
    });
    expect(confirmWrite).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(workspace.exportDocument()).toBe(before);
    expect(before).not.toContain('confirmed');
    expect(before).not.toContain('private-');
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(confirmWrite).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('isolates a stopped remote run from a new run even when its first HTTP request returns late', async () => {
    const firstResponse = deferred<ReturnType<typeof response>>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementation(async () => response({ text: 'new run' }));
    const workspace = new Core.Workspace({
      registry: createRegistry(),
      services: createServices({ request, readCredentials: () => CREDENTIALS }),
    });
    const start = workspace.addNode('start', { x: 0, y: 0 });
    const prompt = workspace.addNode('text', { x: 0, y: 300 });
    workspace.updateNode(prompt.id, { config: { text: 'explicit prompt' } });
    const ai = workspace.addNode('ai-text', { x: 350, y: 0 });
    const output = workspace.addNode('text-result', { x: 700, y: 0 });
    connect(workspace, [start, 'trigger', ai, 'trigger']);
    connect(workspace, [prompt, 'text', ai, 'prompt']);
    connect(workspace, [ai, 'text', output, 'text']);
    const firstRun = workspace.run();
    await flushMicrotasks();
    expect(request).toHaveBeenCalledOnce();
    workspace.stop();
    await firstRun;
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    firstResponse.resolve(response({ text: 'late old output' }));
    await flushMicrotasks();
    expect(workspace.getRuntime().states.get(output.id).outputs).toEqual({ text: 'new run' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('displays structured JSON directly in the text result without a template round trip', async () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const start = workspace.addNode('start', { x: 0, y: 0 });
    const dates = workspace.addNode('date-range', { x: 0, y: 300 });
    workspace.updateNode(dates.id, {
      config: { period: 'custom', since: '2026-10-12', until: '2026-10-18' },
    });
    const output = workspace.addNode('text-result', { x: 350, y: 0 });
    workspace.updateNode(output.id, { config: { format: 'json' } });
    connect(workspace, [start, 'trigger', output, 'trigger']);
    connect(workspace, [dates, 'range', output, 'data']);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(workspace.getRuntime().states.get(output.id).outputs.text)).toMatchObject({
      startDate: '2026-10-12',
      endDate: '2026-10-18',
    });
  });

  it('builds Feishu row matches from the custom date range instead of a hard-coded week label', async () => {
    const request = vi.fn(async (_path: string, _init: RequestInit) => response(TARGET));
    const workspace = new Core.Workspace({
      registry: createRegistry(),
      services: createServices({ request, readCredentials: () => CREDENTIALS }),
    });
    const start = workspace.addNode('start', { x: 0, y: 0 });
    const dates = workspace.addNode('date-range', { x: 0, y: 300 });
    workspace.updateNode(dates.id, {
      config: { period: 'custom', since: '2026-08-24', until: '2026-08-28' },
    });
    const template = workspace.addNode('text-template', { x: 350, y: 0 });
    workspace.updateNode(template.id, {
      config: {
        template:
          '[{"column":"A","value":"{{context.start.month}}.{{context.start.day}}-{{context.end.month}}.{{context.end.day}}","mode":"contains"},{"column":"B","value":"黎君豪","mode":"equals"}]',
      },
    });
    const parser = workspace.addNode('json-parse', { x: 700, y: 0 });
    const lookup = workspace.addNode('feishu-find-row', { x: 1050, y: 0 });
    workspace.updateNode(lookup.id, { config: config('feishu-find-row', { wikiUrl: WIKI }) });
    connect(workspace, [start, 'trigger', template, 'trigger']);
    connect(workspace, [dates, 'range', template, 'context']);
    connect(workspace, [template, 'text', parser, 'text']);
    connect(workspace, [parser, 'data', lookup, 'matches']);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(String(request.mock.calls[0][1].body)).matches).toEqual([
      { column: 'A', value: '8.24-8.28', mode: 'contains' },
      { column: 'B', value: '黎君豪', mode: 'equals' },
    ]);
  });

  it('isolates a failed JSON branch while a separately triggered text result succeeds', async () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const start = workspace.addNode('start', { x: 0, y: 0 });
    const invalid = workspace.addNode('json-input', { x: 0, y: 300 });
    workspace.updateNode(invalid.id, { config: { text: 'invalid-secret-draft' } });
    const template = workspace.addNode('text-template', { x: 350, y: 0 });
    const plain = workspace.addNode('text', { x: 0, y: 600 });
    workspace.updateNode(plain.id, { config: { text: 'independent' } });
    const output = workspace.addNode('text-result', { x: 350, y: 600 });
    connect(workspace, [start, 'trigger', template, 'trigger']);
    connect(workspace, [invalid, 'data', template, 'context']);
    connect(workspace, [start, 'trigger', output, 'trigger']);
    connect(workspace, [plain, 'text', output, 'text']);
    await expect(workspace.run()).resolves.toMatchObject({ status: 'partial' });
    const states = workspace.getRuntime().states;
    expect(states.get(invalid.id)).toMatchObject({ status: 'failed', outputs: null });
    expect(states.get(template.id)).toMatchObject({ status: 'skipped', outputs: null });
    expect(states.get(output.id)).toMatchObject({
      status: 'succeeded',
      outputs: { text: 'independent' },
    });
    expect(states.get(invalid.id).message).not.toContain('invalid-secret-draft');
  });
});
