import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

interface Definition {
  type: string;
  label: string;
  category?: string;
  inputs: { id: string; label: string; dataType: string }[];
  outputs: { id: string; label: string; dataType: string }[];
}
interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  items: Definition[];
  count: number;
}
const loadScript = createRequire(__filename);
const { createRegistry } = loadScript(resolve(__dirname, '../../public/js/workflow-nodes.js'));
const { createPaletteTree } = loadScript(
  resolve(__dirname, '../../public/js/workflow-palette.js'),
) as {
  createPaletteTree(definitions: Definition[], query?: string): Folder;
};
const definitions = createRegistry().list() as Definition[];
const allByFolder = [
  'start',
  'text',
  'date-range',
  'json-input',
  'json-compare',
  'env-compare',
  'json-parse',
  'json-pick',
  'json-merge',
  'text-template',
  'diff-result',
  'text-result',
  'github-commits',
  'ai-text',
  'feishu-find-row',
  'feishu-write-cells',
];
// 语义子类型（date-range、commit-list 等）不再以 json 字样参与搜索，只有通用 JSON 端口匹配。
const jsonNodes = [
  'json-compare',
  'json-parse',
  'json-pick',
  'json-merge',
  'text-template',
  'json-input',
  'text-result',
  'feishu-write-cells',
];
const processingNodes = [
  'json-compare',
  'env-compare',
  'json-parse',
  'json-pick',
  'json-merge',
  'text-template',
];
const triggerNodes = [
  'start',
  ...processingNodes,
  'github-commits',
  'ai-text',
  'feishu-find-row',
  'feishu-write-cells',
  'text-result',
];

/** 按目录收集匹配节点，不依赖 DOM。 */
function items(folder: Folder): Definition[] {
  return [...folder.items, ...folder.folders.flatMap(items)];
}

/** 创建开发者扩展节点元信息。 */
function definition(type: string, category?: string): Definition {
  return { type, label: type, category, inputs: [], outputs: [] };
}

describe('workflow palette folders and local search', () => {
  it('keeps canvas annotations such as regions out of the node library and its search', () => {
    expect(definitions.some((node) => node.type === 'region')).toBe(true);
    expect(items(createPaletteTree(definitions)).map((node) => node.type)).not.toContain('region');
    expect(createPaletteTree(definitions, '区域').count).toBe(0);
  });

  it('derives category folders from the real registry without special-casing node types', () => {
    expect(definitions).toHaveLength(17);
    expect(definitions.slice(0, 5).map((node) => node.type)).toEqual([
      'start',
      'text',
      'json-compare',
      'env-compare',
      'diff-result',
    ]);
    const tree = createPaletteTree(definitions);
    expect(tree.count).toBe(definitions.length - 1); // 区域由工具栏添加，不进入节点库
    expect(items(tree).map((node) => node.type)).toEqual(allByFolder);
    expect(tree.folders.map((folder) => [folder.name, folder.count])).toEqual([
      ['流程控制', 1],
      ['数据输入', 3],
      ['内容处理', 6],
      ['结果展示', 2],
      ['外部能力', 4],
    ]);
    expect(tree.folders[0].items.map((node) => node.type)).toEqual(['start']);
    expect(tree.folders[2].items.map((node) => node.type)).toEqual(processingNodes);
  });

  it.each([
    ['', allByFolder],
    [' \t ', allByFolder],
    ['JSON', jsonNodes],
    ['ＪＳＯＮ', jsonNodes],
    ['env-compare', ['env-compare']],
    ['对比结果', ['json-compare', 'env-compare', 'diff-result']],
    ['内容处理', processingNodes],
    ['A 内容', processingNodes],
    [
      'tExT',
      [
        'text',
        'json-compare',
        'env-compare',
        'json-parse',
        'json-pick',
        'text-template',
        'ai-text',
        'text-result',
      ],
    ],
    ['diff', ['json-compare', 'env-compare', 'diff-result']],
    ['json  diff', ['json-compare']],
    ['diff json', ['json-compare']],
    ['trigger', triggerNodes],
    ['匹配条件', ['feishu-find-row']],
    ['外部能力', ['github-commits', 'ai-text', 'feishu-find-row', 'feishu-write-cells']],
    ['开始', ['start']],
    ['json 缺失关键词', []],
    ['数据筛选', []],
    ['data-filter', []],
    ['未注册的节点', []],
  ])('filters %j across names, types, categories and typed ports', (query, expected) => {
    const tree = createPaletteTree(definitions, query);
    expect(items(tree).map((node) => node.type)).toEqual(expected);
    expect(tree.count).toBe(expected.length);
    expect(tree.folders.every((folder) => folder.count > 0)).toBe(true);
  });

  it('supports nested category paths and does not merge equal folder names under different parents', () => {
    const nodes = [
      definition('first', ' 工具 / 解析 / '),
      definition('second', '文件/解析'),
      definition('third', '工具/解析'),
    ];
    const tree = createPaletteTree(nodes);
    expect(tree.folders.map((folder) => folder.path)).toEqual(['工具', '文件']);
    expect(tree.folders[0].folders[0]).toMatchObject({ name: '解析', path: '工具/解析', count: 2 });
    expect(tree.folders[1].folders[0]).toMatchObject({ path: '文件/解析', count: 1 });
    expect(items(createPaletteTree(nodes, '工具 second'))).toEqual([]);
    expect(items(createPaletteTree(nodes, '解析 third')).map((node) => node.type)).toEqual([
      'third',
    ]);
  });

  it('provides a fallback folder for omitted or empty categories', () => {
    const tree = createPaletteTree([definition('a'), definition('b', ' / / ')]);
    expect(tree.folders).toHaveLength(1);
    expect(tree.folders[0]).toMatchObject({ name: '其他节点', count: 2 });
  });

  it('handles special object keys and markup as literal folder and label data', () => {
    const markup = '<img src=x onerror=alert(1)>';
    const tree = createPaletteTree([
      definition('safe-a', '__proto__/constructor'),
      { ...definition('safe-b', 'toString'), label: markup },
    ]);
    expect(tree.folders[0].folders[0].path).toBe('__proto__/constructor');
    expect(tree.folders[1].name).toBe('toString');
    expect(items(createPaletteTree(items(tree), 'onerror'))[0].label).toBe(markup);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('preserves definitions, renderers and input order without executing or searching private defaults', () => {
    const execute = vi.fn();
    const renderer = vi.fn();
    const node = Object.freeze({
      ...definition('custom', '自定义'),
      defaults: Object.freeze({ text: 'private-input-value' }),
      execute,
      render: renderer,
    });
    Object.freeze(node.inputs);
    Object.freeze(node.outputs);
    const nodes = Object.freeze([node]);
    const tree = createPaletteTree(nodes as unknown as Definition[]);
    expect(items(tree)[0]).toBe(node);
    expect(
      items(createPaletteTree(nodes as unknown as Definition[], 'private-input-value')),
    ).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(renderer).not.toHaveBeenCalled();
  });

  it('returns an empty tree when no definitions are registered', () => {
    expect(createPaletteTree([])).toMatchObject({ folders: [], items: [], count: 0 });
  });
});
