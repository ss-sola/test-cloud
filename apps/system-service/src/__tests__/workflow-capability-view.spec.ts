import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Field {
  key: string;
  type: string;
  label: string;
  options: { value: string | number | boolean; label: string }[] | null;
  min: number | null;
  max: number | null;
}
interface InlineNode {
  type: string;
  text?: string;
  href?: string;
  children?: InlineNode[];
}
interface Block {
  type: string;
  level?: number;
  ordered?: boolean;
  start?: number;
  text?: string;
  children?: InlineNode[];
  items?: { depth: number; children: InlineNode[] }[];
}
interface MatrixInfo {
  rows: number;
  columns: number;
  cells: number;
  matrix: unknown[][];
  issues: string[];
}
interface CapabilityView {
  LIMITS: Record<string, number>;
  normalizeFields(fields: unknown, allowSecrets?: boolean): Array<Field & { group?: string }>;
  readFieldInput(
    field: Partial<Field>,
    raw: string | boolean,
  ): { ok: boolean; value?: unknown; message?: string };
  boundedPreview(value: unknown, limit?: number): { text: string; truncated: boolean };
  safeLinkUrl(value: string): string | null;
  parseMarkdown(text: string, options?: object): { blocks: Block[]; truncated: boolean };
  describeMatrix(range: string, values: unknown): MatrixInfo;
  parseRangeAddress(
    range: string,
  ): { startColumn: number; startRow: number; endColumn: number; endRow: number } | null;
  columnName(index: number): string;
  confirmWrite(options: object): Promise<boolean>;
  capability(options: object): { flush(): void; update(options: object): void; destroy(): void };
}

const loadScript = createRequire(__filename);
const view = loadScript(
  resolve(__dirname, '../../public/js/workflow-capability-view.js'),
) as CapabilityView;
const { createRegistry } = loadScript(resolve(__dirname, '../../public/js/workflow-nodes.js'));

/** 用最小 DOM 与真实事件挂载表单，验证显示、输入和保存行为而不读取浏览器草稿。 */
function mountAiForm(config: Record<string, unknown>) {
  const elements: (EventTarget & { dataset: Record<string, string>; value: string })[] = [];
  function createElement() {
    const element = Object.assign(new EventTarget(), {
      dataset: {} as Record<string, string>,
      value: '',
      classList: { add: vi.fn(), toggle: vi.fn() },
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      append: vi.fn(),
      replaceChildren: vi.fn(),
    });
    elements.push(element);
    return element;
  }
  vi.stubGlobal('document', { createElement });
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const registry = createRegistry();
  const node = {
    id: 'ai',
    type: 'ai-text',
    version: 1,
    name: '旧 AI 节点',
    config: Object.freeze(config),
  };
  const updateNode = vi.fn(
    (_id: string, patch: { config: Record<string, unknown> }, _documentId: string) => {
      const error = registry.get('ai-text').validateConfig(patch.config);
      if (error) throw new Error(error);
    },
  );
  const renderer = view.capability({
    node,
    body: createElement(),
    workspace: { registry, updateNode },
    documentId: 'legacy',
  });
  const contextInput = elements.find(
    (element) => element.dataset.wfField === 'contextWindowTokens',
  )!;
  const restore = elements.find((element) => element.dataset.wfCapabilityAction === 'restore')!;
  return { renderer, contextInput, restore, node, updateNode };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 收集行内节点中的所有链接地址。 */
function links(nodes: InlineNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.type === 'link' && node.href ? [node.href] : []),
    ...links(node.children ?? []),
  ]);
}

describe('workflow-capability-view 字段规范化', () => {
  it('丢弃凭据、原型污染、重复和未知类型字段，保留 maxTokens 这类普通数值', () => {
    const fields = view.normalizeFields([
      { key: 'maxTokens', type: 'number', label: '最大输出', min: 1, max: 8192 },
      { key: 'githubToken', type: 'text', label: 'Token' },
      { key: 'appSecret', type: 'text', label: '密钥' },
      { key: 'api_key', type: 'text', label: 'Key' },
      { key: 'credentialRef', type: 'text', label: '引用' },
      { key: '__proto__', type: 'text', label: '原型' },
      { key: 'constructor', type: 'text', label: '构造' },
      { key: 'maxTokens', type: 'number', label: '重复' },
      { key: 'script', type: 'html', label: '未知类型' },
      { key: 'mode', type: 'select', label: '模式', options: [] },
      { key: 'branch', type: 'text' },
    ]);
    expect(fields.map((field) => field.key)).toEqual(['maxTokens', 'branch']);
    expect(fields[1].label).toBe('branch');
  });

  it('只在本地配置节点渲染 password 凭据字段，凭据键仍不能以明文类型出现', () => {
    const declared = [
      { key: 'githubToken', type: 'password', label: 'GitHub Token', group: 'github' },
      { key: 'appSecret', type: 'text', label: '明文密钥' },
      { key: 'aiModel', type: 'text', label: 'AI 模型' },
    ];
    expect(view.normalizeFields(declared).map((field) => field.key)).toEqual(['aiModel']);
    expect(
      view.normalizeFields(declared, true).map((field) => [field.key, field.type, field.group]),
    ).toEqual([
      ['githubToken', 'password', 'github'],
      ['aiModel', 'text', undefined],
    ]);
  });

  it('builds a Monday-first six-week calendar and reads only real dates from manual input', () => {
    const calendar = (
      view as unknown as {
        calendarDays(
          year: number,
          month: number,
        ): { date: string; day: number; inMonth: boolean }[];
      }
    ).calendarDays;
    const parse = (view as unknown as { parseDatePrefix(value: unknown): Date | null })
      .parseDatePrefix;
    const august = calendar(2026, 7);
    expect(august).toHaveLength(42);
    expect(august[0]).toEqual({ date: '2026-07-27', day: 27, inMonth: false });
    expect(august.find((cell) => cell.inMonth)).toEqual({
      date: '2026-08-01',
      day: 1,
      inMonth: true,
    });
    expect(august.filter((cell) => cell.inMonth)).toHaveLength(31);
    expect(calendar(2026, 1)[0].date).toBe('2026-01-26');
    expect(parse('2026-08-24')?.getDate()).toBe(24);
    expect(parse(' 2026-08-28T23:59:59+08:00 ')?.getMonth()).toBe(7);
    expect([parse('2026-02-30'), parse('8.24'), parse(''), parse(null)]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('keeps date fields as text-valued controls so a picker and manual ISO input share one config value', () => {
    const [date] = view.normalizeFields([
      { key: 'since', type: 'date', label: '开始时间', placeholder: 'YYYY-MM-DD' },
    ]);
    expect(date).toMatchObject({ key: 'since', type: 'date', placeholder: 'YYYY-MM-DD' });
    expect(view.readFieldInput(date, '2026-10-12T08:00:00+08:00')).toEqual({
      ok: true,
      value: '2026-10-12T08:00:00+08:00',
    });
    expect(view.readFieldInput(date, '')).toEqual({ ok: true, value: '' });
    const range = createRegistry().get('date-range', 1);
    expect(
      range.fields
        .filter((field: { type: string }) => field.type === 'date')
        .map((field: { key: string }) => field.key),
    ).toEqual(['since', 'until']);
  });

  it('只为文本域保留占满高度，只为文本类字段保留字数提示，文本节点改用声明式表单', () => {
    const [area, line, choice] = view.normalizeFields([
      {
        key: 'text',
        type: 'textarea',
        label: '文本',
        fill: true,
        counter: true,
        placeholder: '输入文本',
      },
      { key: 'branch', type: 'text', fill: true, counter: true },
      { key: 'mode', type: 'select', counter: true, options: [{ value: 'a', label: 'A' }] },
    ]);
    expect(area).toMatchObject({ fill: true, counter: true, placeholder: '输入文本' });
    expect(line).toMatchObject({ fill: false, counter: true, placeholder: '' });
    expect(choice).toMatchObject({ fill: false, counter: false });
    const text = createRegistry({ capability: view.capability }).get('text', 1);
    expect(text.render).toBe(view.capability);
    expect(text.preview).toBe(false);
    expect(view.normalizeFields(text.fields)).toEqual([
      expect.objectContaining({ key: 'text', type: 'textarea', fill: true, counter: true }),
    ]);
  });

  it('数字字段必须有限且在声明范围内，选项字段必须是声明过的值并保留原始类型', () => {
    const [number, select] = view.normalizeFields([
      { key: 'maxCommits', type: 'number', label: '数量', min: 1, max: 500 },
      {
        key: 'period',
        type: 'select',
        label: '周期',
        options: [
          { value: 'last-week', label: '上周' },
          { value: 3, label: '数字选项' },
        ],
      },
    ]);
    expect(view.readFieldInput(number, ' 120 ')).toEqual({ ok: true, value: 120 });
    for (const raw of ['', 'abc', '0', '501', 'Infinity']) {
      expect(view.readFieldInput(number, raw).ok).toBe(false);
    }
    expect(view.readFieldInput(select, '3')).toEqual({ ok: true, value: 3 });
    expect(view.readFieldInput(select, 'this-week').ok).toBe(false);
    expect(view.readFieldInput({ type: 'checkbox' }, true)).toEqual({ ok: true, value: true });
  });
});

describe('workflow-capability-view AI 上下文表单', () => {
  it('渲染、同步、flush 和恢复只显示旧节点缺省窗口，不自动保存或将 maxTokens 当窗口', async () => {
    vi.useFakeTimers();
    const legacy = {
      systemPrompt: 'legacy system',
      credentialRef: 'token-config',
      maxTokens: 4096,
    };
    const { renderer, contextInput, restore, node, updateNode } = mountAiForm(legacy);
    expect(contextInput.value).toBe('100000');
    renderer.flush();
    renderer.update({ node, state: { status: 'idle', outputs: null }, locked: false });
    expect(contextInput.value).toBe('100000');
    contextInput.value = '65536';
    contextInput.dispatchEvent(new Event('input'));
    restore.dispatchEvent(new Event('click'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(contextInput.value).toBe('100000');
    renderer.flush();
    expect(updateNode).not.toHaveBeenCalled();
    expect(node.config).toEqual(legacy);
    expect(node.config).not.toHaveProperty('contextWindowTokens');
    renderer.destroy();
  });

  it('使用保存的窗口；非法整数不提交，只有显式有效编辑才保存上下文', () => {
    vi.useFakeTimers();
    const saved = {
      systemPrompt: '',
      contextWindowTokens: 65536,
      credentialRef: 'token-config',
      maxTokens: 1,
    };
    const { renderer, contextInput, restore, node, updateNode } = mountAiForm(saved);
    expect(contextInput.value).toBe('65536');
    for (const raw of ['', '4095', '1000001', '4096.5']) {
      contextInput.value = raw;
      contextInput.dispatchEvent(new Event('input'));
      expect(() => renderer.flush()).toThrow('配置未保存');
    }
    expect(updateNode).toHaveBeenCalledExactlyOnceWith(
      'ai',
      { config: { ...saved, contextWindowTokens: 4096.5 } },
      'legacy',
    );
    expect(node.config).toEqual(saved);
    restore.dispatchEvent(new Event('click'));
    expect(contextInput.value).toBe('65536');
    updateNode.mockClear();
    contextInput.value = '150000';
    contextInput.dispatchEvent(new Event('input'));
    renderer.flush();
    expect(updateNode).toHaveBeenCalledExactlyOnceWith(
      'ai',
      { config: { ...saved, contextWindowTokens: 150000 } },
      'legacy',
    );
    expect(node.config).toEqual(saved);
    renderer.destroy();
  });
});

describe('workflow-capability-view 有界预览', () => {
  it('超过预算立即截断，不序列化完整的大数组', () => {
    const big = Array.from({ length: 1_000_000 }, (_, index) => ({ index }));
    const { text, truncated } = view.boundedPreview(big, 500);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it('预算内输出完整的缩进 JSON', () => {
    const value = { a: [1, 'x'], b: null };
    const { text, truncated } = view.boundedPreview(value);
    expect(truncated).toBe(false);
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe('workflow-capability-view 安全 Markdown', () => {
  it('只允许 http/https 绝对链接，拒绝脚本、数据、相对和带账号的地址', () => {
    expect(view.safeLinkUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(view.safeLinkUrl('HTTP://example.com')).toBe('http://example.com/');
    for (const unsafe of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'java\nscript:alert(1)',
      '/relative/path',
      '//example.com',
      'https://user:pass@example.com',
      'https://example.com/"onclick="x',
      'ftp://example.com',
    ]) {
      expect(view.safeLinkUrl(unsafe)).toBeNull();
    }
  });

  it('解析标题、列表、围栏代码、强调与安全链接', () => {
    const { blocks, truncated } = view.parseMarkdown(
      [
        '## 本周进展',
        '',
        '- 完成 **登录** 重构',
        '- 修复 `cache` 问题，详见 [说明](https://example.com/doc)',
        '',
        '3. 第三项',
        '4. 第四项',
        '',
        '```ts',
        'const a = "**不解析**"',
        '```',
      ].join('\n'),
    );
    expect(truncated).toBe(false);
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'list', 'list', 'code']);
    expect(blocks[0].level).toBe(2);
    const bullet = blocks[1];
    expect(bullet.ordered).toBe(false);
    expect(bullet.items).toHaveLength(2);
    expect(bullet.items?.[0].children.map((node) => node.type)).toEqual(['text', 'strong', 'text']);
    expect(bullet.items?.[1].children.map((node) => node.type)).toContain('code');
    expect(links(bullet.items?.[1].children ?? [])).toEqual(['https://example.com/doc']);
    expect(blocks[2]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[3].text).toBe('const a = "**不解析**"');
  });

  it('HTML、图片和 javascript 链接都不会变成元素或链接', () => {
    const { blocks } = view.parseMarkdown(
      '<img src=x onerror=alert(1)> ![图](https://example.com/a.png) [点我](javascript:alert(1)) <script>alert(1)</script>',
    );
    const inline = blocks[0].children ?? [];
    expect(blocks).toHaveLength(1);
    expect(inline.every((node) => node.type === 'text')).toBe(true);
    expect(links(inline)).toEqual([]);
    expect(inline.map((node) => node.text).join('')).toContain('<script>alert(1)</script>');
  });

  it('未闭合的围栏、强调与下划线单词保持原文且不抛错', () => {
    const { blocks } = view.parseMarkdown('```\n未闭合\n**未闭合 snake_case_name');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'code' });
    const [paragraph] = view.parseMarkdown('**粗 snake_case_name 与 *斜*').blocks;
    expect(paragraph.children?.some((node) => node.type === 'em')).toBe(true);
    expect(paragraph.children?.some((node) => node.type === 'strong')).toBe(false);
  });

  it('50 万字符输入受字符与块预算限制，不会生成与长度成比例的结构', () => {
    const source = '- 项目 *x*\n'.repeat(60_000);
    expect(source.length).toBeGreaterThan(500_000 - 1);
    const { blocks, truncated } = view.parseMarkdown(source);
    const items = blocks.reduce((total, block) => total + (block.items?.length ?? 0), 0);
    expect(truncated).toBe(true);
    expect(items).toBeLessThanOrEqual(view.LIMITS.markdownChars / 5);

    const paragraphs = view.parseMarkdown('段落\n\n'.repeat(20_000), { maxChars: 500_000 });
    expect(paragraphs.blocks).toHaveLength(view.LIMITS.markdownBlocks);
    expect(paragraphs.truncated).toBe(true);
  });

  it('大量未闭合标记不会造成二次方耗时', () => {
    const started = Date.now();
    view.parseMarkdown('*a [b `c _d '.repeat(2400));
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('workflow-capability-view 写入确认矩阵', () => {
  const grid = (rows: number, columns: number, cell: unknown = 'x') =>
    Array.from({ length: rows }, () => Array.from({ length: columns }, () => cell));

  it('范围按适配器同一规则解析：只接受不含工作表标识的大写绝对矩形，列不超过 ZZ、行不超过 1000000', () => {
    expect(view.parseRangeAddress('C5:G5')).toEqual({
      startColumn: 2,
      startRow: 5,
      endColumn: 6,
      endRow: 5,
    });
    expect(view.parseRangeAddress('ZZ1:ZZ1000000')).toMatchObject({
      startColumn: 701,
      endRow: 1_000_000,
    });
    for (const invalid of [
      'C5',
      'Sheet1!C5:G5',
      'c5:g5',
      'AAA1:AAA1',
      'A1:A1000001',
      'G5:C5',
      'A0:A1',
      'not a range',
    ]) {
      expect(view.parseRangeAddress(invalid)).toBeNull();
    }
    expect([0, 25, 26, 27, 701, 702].map(view.columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'ZZ',
      'AAA',
    ]);
  });

  it('尺寸与范围一致的矩形矩阵没有问题，并复制为快照', () => {
    const values = [['完成登录', 3, true, null, '']];
    const info = view.describeMatrix('C5:G5', values);
    expect(info.issues).toEqual([]);
    expect(info).toMatchObject({ rows: 1, columns: 5, cells: 5 });
    values[0][0] = '被改动';
    expect(info.matrix[0][0]).toBe('完成登录');
  });

  it('所有适配器允许的边界矩阵都能完整确认：单格 8000 字符、200 行、50 列、2000 单元格', () => {
    expect(view.describeMatrix('A1:A1', [['x'.repeat(8000)]]).issues).toEqual([]);
    expect(view.describeMatrix('A1:A1', [['汉'.repeat(8000)]]).issues).toEqual([]);
    expect(view.describeMatrix('A1:J200', grid(200, 10)).issues).toEqual([]);
    expect(view.describeMatrix('A1:AX40', grid(40, 50)).issues).toEqual([]);
    const full = view.describeMatrix('ZY999801:ZZ1000000', grid(200, 2));
    expect(full.issues).toEqual([]);
    expect(full.matrix).toHaveLength(200);
  });

  it('超出适配器预算时拒绝确认：行列数、单元格数、单格长度、UTF-8 字节、坐标', () => {
    const issues = (range: string, values: unknown) =>
      view.describeMatrix(range, values).issues.join();
    expect(issues('A1:A1', [['x'.repeat(8001)]])).toContain('8000');
    expect(issues('A1:J201', grid(201, 10))).toContain('上限');
    expect(issues('A1:AY1', grid(1, 51))).toContain('上限');
    expect(issues('A1:AX41', grid(41, 50))).toContain('上限');
    expect(issues('A1:A100', grid(100, 1, 'x'.repeat(6000)))).toContain('512 KiB');
    expect(issues('A1:A30', grid(30, 1, '汉'.repeat(8000)))).toContain('512 KiB');
    expect(issues('AAA1:AAA1', [['x']])).toContain('范围');
    expect(issues('A1000000:A1000001', grid(2, 1))).toContain('范围');
  });

  it('范围不一致、非矩形、类型不支持和非有限数字都要求拒绝确认', () => {
    expect(view.describeMatrix('C5:F5', [['a', 'b', 'c', 'd', 'e']]).issues.join()).toContain(
      '不一致',
    );
    expect(view.describeMatrix('C5:D6', [['a', 'b'], ['c']]).issues.join()).toContain('矩形');
    expect(view.describeMatrix('C5:C5', [[{ formula: 1 }]]).issues.join()).toContain('不支持');
    expect(view.describeMatrix('C5:C5', [[Number.NaN]]).issues.join()).toContain('非有限');
    expect(view.describeMatrix('A1:A1', []).issues).toHaveLength(1);
  });

  it('没有 DOM 的环境默认拒绝写入，已取消的信号也直接拒绝', async () => {
    const values = [['a']];
    await expect(
      view.confirmWrite({ wikiUrl: 'https://x.feishu.cn/wiki/a', range: 'A1:A1', values }),
    ).resolves.toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      view.confirmWrite({
        wikiUrl: 'https://x.feishu.cn/wiki/a',
        range: 'A1:A1',
        values,
        signal: controller.signal,
      }),
    ).resolves.toBe(false);
  });
});
