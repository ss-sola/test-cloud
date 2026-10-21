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
const { createPaletteTree } = loadScript(resolve(__dirname, '../../public/js/workflow-palette.js')) as {
  createPaletteTree(definitions: Definition[], query?: string): Folder;
};
const definitions = createRegistry().list() as Definition[];

/** 按目录收集匹配节点，不依赖 DOM。 */
function items(folder: Folder): Definition[] {
  return [...folder.items, ...folder.folders.flatMap(items)];
}

/** 创建开发者扩展节点元信息。 */
function definition(type: string, category?: string): Definition {
  return { type, label: type, category, inputs: [], outputs: [] };
}

describe('workflow palette folders and local search', () => {
  it('derives category folders from the real registry without special-casing node types', () => {
    expect(definitions).toHaveLength(5);
    const tree = createPaletteTree(definitions);
    expect(tree.count).toBe(5);
    expect(tree.folders.map((folder) => [folder.name, folder.count])).toEqual([
      ['流程控制', 1], ['数据输入', 1], ['内容处理', 2], ['结果展示', 1],
    ]);
    expect(tree.folders[0].items.map((node) => node.type)).toEqual(['start']);
    expect(tree.folders[2].items.map((node) => node.type)).toEqual(['json-compare', 'env-compare']);
  });

  it.each([
    ['', ['start', 'text', 'json-compare', 'env-compare', 'diff-result']],
    [' \t ', ['start', 'text', 'json-compare', 'env-compare', 'diff-result']],
    ['JSON', ['json-compare']],
    ['ＪＳＯＮ', ['json-compare']],
    ['env-compare', ['env-compare']],
    ['对比结果', ['json-compare', 'env-compare', 'diff-result']],
    ['内容处理', ['json-compare', 'env-compare']],
    ['A 内容', ['json-compare', 'env-compare']],
    ['tExT', ['text', 'json-compare', 'env-compare']],
    ['diff', ['json-compare', 'env-compare', 'diff-result']],
    ['json  diff', ['json-compare']],
    ['diff json', ['json-compare']],
    ['trigger', ['start', 'json-compare', 'env-compare']],
    ['开始', ['start']],
    ['json 缺失关键词', []],
    ['未注册的节点', []],
  ])('filters %j across names, types, categories and typed ports', (query, expected) => {
    const tree = createPaletteTree(definitions, query);
    expect(items(tree).map((node) => node.type)).toEqual(expected);
    expect(tree.count).toBe(expected.length);
    expect(tree.folders.every((folder) => folder.count > 0)).toBe(true);
  });

  it('supports nested category paths and does not merge equal folder names under different parents', () => {
    const nodes = [definition('first', ' 工具 / 解析 / '), definition('second', '文件/解析'), definition('third', '工具/解析')];
    const tree = createPaletteTree(nodes);
    expect(tree.folders.map((folder) => folder.path)).toEqual(['工具', '文件']);
    expect(tree.folders[0].folders[0]).toMatchObject({ name: '解析', path: '工具/解析', count: 2 });
    expect(tree.folders[1].folders[0]).toMatchObject({ path: '文件/解析', count: 1 });
    expect(items(createPaletteTree(nodes, '工具 second'))).toEqual([]);
    expect(items(createPaletteTree(nodes, '解析 third')).map((node) => node.type)).toEqual(['third']);
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
    const node = Object.freeze({ ...definition('custom', '自定义'), defaults: Object.freeze({ text: 'private-input-value' }), execute, render: renderer });
    Object.freeze(node.inputs);
    Object.freeze(node.outputs);
    const nodes = Object.freeze([node]);
    const tree = createPaletteTree(nodes as unknown as Definition[]);
    expect(items(tree)[0]).toBe(node);
    expect(items(createPaletteTree(nodes as unknown as Definition[], 'private-input-value'))).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(renderer).not.toHaveBeenCalled();
  });

  it('returns an empty tree when no definitions are registered', () => {
    expect(createPaletteTree([])).toMatchObject({ folders: [], items: [], count: 0 });
  });
});
