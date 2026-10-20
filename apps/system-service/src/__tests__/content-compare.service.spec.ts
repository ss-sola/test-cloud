import { ProjectException } from '@nest-cloud/common';
import { describe, expect, it } from 'vitest';
import { CONTENT_COMPARE_LIMITS } from '../constants/content-compare.constants';
import { ContentCompareException } from '../modules/content-compare/content-compare.exception';
import { ContentCompareService } from '../modules/content-compare/content-compare.service';
import type {
  CompareContentInput,
  CompareInputErrors,
  ContentCompareResult,
  ContentDiffNode,
} from '../modules/content-compare/content-compare.types';
import { EnvParserUtil } from '../modules/content-compare/env-parser.util';
import { JsonCompareUtil } from '../modules/content-compare/json-compare.util';
import { JsonSegmentUtil } from '../modules/content-compare/json-segment.util';
import { OutputBudgetUtil } from '../modules/content-compare/output-budget.util';

const service = new ContentCompareService();
const BOM = '\uFEFF';

const compareJson = (left: string, right: string): ContentCompareResult =>
  service.compare({ format: 'json', left, right });
const compareEnv = (left: string, right: string): ContentCompareResult =>
  service.compare({ format: 'env', left, right });

function catchException(input: CompareContentInput): ContentCompareException {
  let caught: unknown;
  try {
    service.compare(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContentCompareException);
  return caught as ContentCompareException;
}

function findNode(node: ContentDiffNode, path: string): ContentDiffNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return undefined;
}

function collectNodes(node: ContentDiffNode, nodes: ContentDiffNode[] = []): ContentDiffNode[] {
  nodes.push(node);
  node.children.forEach((child) => collectNodes(child, nodes));
  return nodes;
}

const joinSegments = (segments: Array<{ text: string }>) =>
  segments.map((segment) => segment.text).join('');

describe('ContentCompareService JSON rules', () => {
  it('matches identity arrays independent of input order', () => {
    const result = compareJson(
      '{"items":[{"id":2,"name":"b"},{"id":1,"name":"a"}]}',
      '{"items":[{"id":1,"name":"A"},{"id":3,"name":"c"}]}',
    );

    expect(result.stats).toEqual({ added: 1, removed: 1, modified: 1 });
    expect(JSON.parse(result.leftText)).toEqual({
      items: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
    });
    expect(JSON.parse(result.rightText)).toEqual({
      items: [
        { id: 1, name: 'A' },
        { id: 3, name: 'c' },
      ],
    });
    expect(result.tree.path).toBe('$');
    expect(findNode(result.tree, '$.items[id=1].name')?.status).toBe('modified');
    expect(findNode(result.tree, '$.items[id=2]')?.status).toBe('removed');
    expect(findNode(result.tree, '$.items[id=3]')?.status).toBe('added');
  });

  it('treats reordered non-identity arrays as unchanged after normalization', () => {
    const result = compareJson('{"values":[3,1,2]}', '{"values":[2,3,1]}');

    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 0 });
    expect(JSON.parse(result.leftText)).toEqual({ values: [1, 2, 3] });
  });

  it('sorts mixed-type plain arrays by canonical form and ignores order', () => {
    const result = compareJson('[3,"3",true,null,{"a":1}]', '[{"a":1},null,true,"3",3]');

    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 0 });
    expect(result.leftText).toBe(result.rightText);
  });

  it('serializes changed leaves into side-specific segments', () => {
    const result = compareJson('{"name":"before"}', '{"name":"after","ready":true}');

    expect(result.segments.left.some((segment) => segment.status === 'modified')).toBe(true);
    expect(result.segments.right.some((segment) => segment.status === 'added')).toBe(true);
    expect(result.segments.left.some((segment) => segment.status === 'added')).toBe(false);
    expect(result.stats).toEqual({ added: 1, removed: 0, modified: 1 });
  });

  it('keeps special keys as own properties without touching prototypes', () => {
    const result = compareJson(
      '{"__proto__":{"polluted":1},"constructor":"x","b":1}',
      '{"__proto__":{"polluted":2},"constructor":"x","b":1}',
    );

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.tree.children.map((child) => child.key)).toEqual([
      '__proto__',
      'b',
      'constructor',
    ]);
    expect(findNode(result.tree, '$.__proto__.polluted')?.status).toBe('modified');
    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 1 });
    expect(Object.keys(JSON.parse(result.leftText))).toContain('__proto__');
  });

  it('builds text from segments so numeric-like keys keep one order', () => {
    const result = compareJson('{"b":1,"10":2,"2":3}', '{"b":1,"10":2,"2":4}');

    expect(result.leftText).toBe('{\n  "10": 2,\n  "2": 3,\n  "b": 1\n}');
    expect(result.leftText).not.toBe(JSON.stringify(JSON.parse(result.leftText), null, 2));
    expect(result.segments.left).toEqual([
      { text: '{\n  "10": 2,\n  ', status: null },
      { text: '"2"', status: 'modified' },
      { text: ': ', status: null },
      { text: '3', status: 'modified' },
      { text: ',\n  "b": 1\n}', status: null },
    ]);
  });

  it('keeps leftText and rightText identical to their segments and stable on re-compare', () => {
    const left =
      '{"z":[3,1,2],"items":[{"id":2,"n":"b"},{"id":1,"n":"a"}],"n":{"b":1,"a":2,"7":[],"1":{}},"e":"é\\u0001"}';
    const right = '{"z":[1,2],"items":[{"id":1,"n":"A"}],"n":{"a":2,"b":[1]},"x":null}';
    const result = compareJson(left, right);

    expect(result.leftText).toBe(joinSegments(result.segments.left));
    expect(result.rightText).toBe(joinSegments(result.segments.right));
    const again = compareJson(result.leftText, result.rightText);
    expect(again.leftText).toBe(result.leftText);
    expect(again.rightText).toBe(result.rightText);
    expect(again.stats).toEqual(result.stats);
  });

  it('renders each side in its own identity order even when the identity field differs', () => {
    const result = compareJson(
      '{"list":[{"id":1,"userId":"b"},{"id":2,"userId":"a"}]}',
      '{"list":[{"userId":"a"},{"userId":"b"}]}',
    );

    expect(findNode(result.tree, '$.list')?.children.map((child) => child.key)).toEqual(['a', 'b']);
    expect(JSON.parse(result.leftText).list.map((item: { userId: string }) => item.userId)).toEqual(
      ['b', 'a'],
    );
    expect(findNode(result.tree, '$.list[userId=%22a%22]')?.status).toBe('modified');
  });

  it('distinguishes identity value types and falls back to indexes for invalid identities', () => {
    const typed = compareJson('[{"id":1,"v":1}]', '[{"id":"1","v":1}]');
    expect(typed.stats).toEqual({ added: 1, removed: 1, modified: 0 });
    expect(typed.tree.children.map((child) => [child.path, child.status])).toEqual([
      ['$[id=1]', 'removed'],
      ['$[id=%221%22]', 'added'],
    ]);

    const duplicated = compareJson(
      '[{"id":1,"v":1},{"id":1,"v":2}]',
      '[{"id":1,"v":1},{"id":1,"v":3}]',
    );
    expect(duplicated.tree.children.map((child) => child.path)).toEqual(['$[0]', '$[1]']);
    expect(findNode(duplicated.tree, '$[1].v')?.status).toBe('modified');

    const invalid = compareJson('[{"id":true},{"id":false}]', '[{"id":false},{"id":true}]');
    expect(invalid.tree.children.map((child) => child.path)).toEqual(['$[0]', '$[1]']);
    expect(invalid.stats).toEqual({ added: 0, removed: 0, modified: 0 });

    const missing = compareJson('[{"id":1},{"name":"x"}]', '[{"id":1},{"name":"x"}]');
    expect(missing.tree.children.map((child) => child.path)).toEqual(['$[0]', '$[1]']);
  });

  it('matches arrays by a single shared *Id field and prefers id', () => {
    const byUserId = compareJson(
      '[{"userId":"a","id":1},{"userId":"b","id":1}]',
      '[{"userId":"b","x":1},{"userId":"a","x":1}]',
    );
    expect(byUserId.tree.children.map((child) => child.path)).toEqual([
      '$[userId=%22a%22]',
      '$[userId=%22b%22]',
    ]);

    const ambiguous = compareJson(
      '[{"aId":1,"bId":1},{"aId":2,"bId":2}]',
      '[{"aId":1,"bId":2},{"aId":2,"bId":1}]',
    );
    expect(ambiguous.tree.children.map((child) => child.path)).toEqual(['$[0]', '$[1]']);

    const preferId = compareJson(
      '[{"id":1,"aId":1},{"id":2,"aId":2}]',
      '[{"id":1,"aId":9},{"id":2,"aId":8}]',
    );
    expect(preferId.tree.children.map((child) => child.path)).toEqual(['$[id=1]', '$[id=2]']);
  });

  it('reports container and scalar type changes as a single modified leaf with side counts', () => {
    const result = compareJson(
      '{"a":{"x":1,"y":2},"b":[1,2,3],"c":"text","d":null}',
      '{"a":[1],"b":{"k":1},"c":{"p":1,"q":2},"d":0}',
    );

    const a = findNode(result.tree, '$.a');
    expect(a).toMatchObject({
      status: 'modified',
      type: 'value',
      leftDisplay: '{ 2 个键 }',
      rightDisplay: '[ 1 项 ]',
      children: [],
    });
    expect(findNode(result.tree, '$.b')).toMatchObject({
      leftDisplay: '[ 3 项 ]',
      rightDisplay: '{ 1 个键 }',
    });
    expect(findNode(result.tree, '$.c')).toMatchObject({
      leftDisplay: '"text"',
      rightDisplay: '{ 2 个键 }',
    });
    expect(findNode(result.tree, '$.d')).toMatchObject({ leftDisplay: 'null', rightDisplay: '0' });
    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 4 });
  });

  it('handles added and removed subtrees in the right direction without repeating their content', () => {
    const left = '{"a":1}';
    const right = '{"a":1,"b":{"c":{"d":"TOPSECRETVALUE"}}}';
    const forward = compareJson(left, right);
    const added = findNode(forward.tree, '$.b') as ContentDiffNode;

    expect(added).toMatchObject({
      status: 'added',
      hasLeft: false,
      hasRight: true,
      type: 'object',
      leftDisplay: '',
      rightDisplay: '{ 1 个键 }',
      children: [],
    });
    expect(forward.stats).toEqual({ added: 1, removed: 0, modified: 0 });
    expect(JSON.stringify(forward.tree)).not.toContain('TOPSECRETVALUE');
    expect(forward.segments.right).toEqual([
      { text: '{\n  "a": 1,\n  ', status: null },
      { text: '"b"', status: 'added' },
      { text: ': ', status: null },
      { text: '{\n    "c": {\n      "d": "TOPSECRETVALUE"\n    }\n  }', status: 'added' },
      { text: '\n}', status: null },
    ]);
    expect(forward.segments.left).toEqual([{ text: '{\n  "a": 1\n}', status: null }]);

    const backward = compareJson(right, left);
    expect(findNode(backward.tree, '$.b')).toMatchObject({
      status: 'removed',
      hasLeft: true,
      hasRight: false,
      leftDisplay: '{ 1 个键 }',
      rightDisplay: '',
    });
    expect(backward.stats).toEqual({ added: 0, removed: 1, modified: 0 });
    expect(backward.segments.left.some((segment) => segment.status === 'removed')).toBe(true);
    expect(backward.segments.right.some((segment) => segment.status !== null)).toBe(false);
  });

  it('returns only compact public node fields', () => {
    const result = compareJson('{"a":{"b":[1,{"c":2}]}}', '{"a":{"b":[1,{"c":3}]}}');

    for (const node of collectNodes(result.tree)) {
      expect(Object.keys(node).sort()).toEqual(
        [
          'children',
          'hasLeft',
          'hasRight',
          'key',
          'leftDisplay',
          'path',
          'rightDisplay',
          'status',
          'type',
        ].sort(),
      );
    }
    expect(Object.keys(result).sort()).toEqual(
      ['leftText', 'rightText', 'segments', 'stats', 'tree'].sort(),
    );
  });

  it('compares scalar roots and empty containers', () => {
    expect(compareJson('1', '2').stats.modified).toBe(1);
    expect(compareJson('null', 'null').stats).toEqual({ added: 0, removed: 0, modified: 0 });
    const empty = compareJson('{"a":[],"b":{}}', '{"a":[],"b":{}}');
    expect(empty.stats).toEqual({ added: 0, removed: 0, modified: 0 });
    expect(empty.leftText).toBe('{\n  "a": [],\n  "b": {}\n}');
  });
});

describe('ContentCompareService input errors', () => {
  it('reports both sides together without leaking original content', () => {
    const error = catchException({
      format: 'json',
      left: '{"secret":"TOPSECRETVALUE",}',
      right: '{"ok":true',
    });
    const errors = error.errors as CompareInputErrors;

    expect(error).toBeInstanceOf(ProjectException);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error.getStatus()).toBe(400);
    expect(errors.left.map((item) => item.code)).toEqual(['INVALID_JSON']);
    expect(errors.right.map((item) => item.code)).toEqual(['INVALID_JSON']);
    expect(JSON.stringify(errors) + error.message).not.toMatch(/TOPSECRETVALUE|secret|"ok"/);
  });

  it('keeps a valid side clean and rejects empty or whitespace input', () => {
    const empty = catchException({ format: 'json', left: '', right: '{}' });
    expect(empty.errors?.left.map((item) => item.code)).toEqual(['EMPTY']);
    expect(empty.errors?.right).toEqual([]);

    const blank = catchException({ format: 'env', left: 'A=1', right: ' \r\n\t' });
    expect(blank.errors?.left).toEqual([]);
    expect(blank.errors?.right.map((item) => item.code)).toEqual(['EMPTY']);
    expect(catchException({ format: 'env', left: BOM, right: 'A=1' }).errors?.left[0].code).toBe(
      'EMPTY',
    );
  });

  it('rejects non-string input as a controlled side error', () => {
    const error = catchException({
      format: 'json',
      left: 1 as unknown as string,
      right: '{}',
    });

    expect(error.errors?.left.map((item) => item.code)).toEqual(['INVALID_TYPE']);
  });

  it('reports malformed ENV lines with codes, line numbers and no key or value text', () => {
    const error = catchException({
      format: 'env',
      left: 'BAD-SECRETKEY=x\nNO_SECRETEQUALS\nOPEN="SECRETVAL\nOK="done"SECRETJUNK\nNAME=one\nNAME=two',
      right: 'A=1',
    });
    const errors = error.errors as CompareInputErrors;

    expect(errors.left.map(({ code, line }) => [code, line])).toEqual([
      ['INVALID_KEY', 1],
      ['MISSING_EQUALS', 2],
      ['UNTERMINATED_QUOTE', 3],
      ['TRAILING_CONTENT', 4],
      ['DUPLICATE_KEY', 6],
    ]);
    expect(errors.left.at(-1)?.previousLine).toBe(5);
    expect(errors.right).toEqual([]);
    expect(JSON.stringify(errors) + error.message).not.toMatch(/SECRET|NAME|done/);
  });
});

describe('EnvParserUtil', () => {
  it('preserves ENV string values and quoted syntax', () => {
    const result = EnvParserUtil.parse(
      `${BOM}# comment\r\nexport APP_NAME="particle"\r\nPORT=3000\r\nURL=a=b#fragment\r\nHASH=foo # trailing comment\r\nEMPTY=\r\nSQ='a\\'b\\n'\r\nDQ="a\\"b\\n\\x"  # tail`,
    );

    expect(result.ok).toBe(true);
    expect(Object.fromEntries(Object.entries(result.value ?? {}))).toEqual({
      APP_NAME: 'particle',
      PORT: '3000',
      URL: 'a=b#fragment',
      HASH: 'foo',
      EMPTY: '',
      SQ: "a'b\\n",
      DQ: 'a"b\n\\x',
    });
    expect([...result.lineKeys.entries()].slice(0, 3)).toEqual([
      [2, 'APP_NAME'],
      [3, 'PORT'],
      [4, 'URL'],
    ]);
  });

  it('reports malformed ENV lines without accepting partial values', () => {
    const result = EnvParserUtil.parse(
      'BAD-KEY=x\nNO_EQUALS\nOPEN="value\nOK="done"junk\nNAME=one\nNAME=two\n=x',
    );

    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(result.errors.map(({ code, line }) => [code, line])).toEqual([
      ['INVALID_KEY', 1],
      ['MISSING_EQUALS', 2],
      ['UNTERMINATED_QUOTE', 3],
      ['TRAILING_CONTENT', 4],
      ['DUPLICATE_KEY', 6],
      ['EMPTY_KEY', 7],
    ]);
    expect(result.errors[4].previousLine).toBe(5);
    expect(result.errors.every((error) => error.column === 1)).toBe(true);
  });

  it('keeps special ENV keys as own properties', () => {
    const result = EnvParserUtil.parse('__proto__=safe\nconstructor=value');

    expect(result.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result.value, '__proto__')).toBe(true);
    expect(result.value?.__proto__).toBe('safe');
    expect(result.value?.constructor).toBe('value');
    expect(({} as Record<string, unknown>).safe).toBeUndefined();
  });

  it('counts lines across CRLF, CR and LF consistently and stops at the error cap', () => {
    const mixed = EnvParserUtil.parse('A=1\r\nB=2\rC=3\nD=4');
    expect([...mixed.lineKeys.entries()]).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
      [4, 'D'],
    ]);

    const capped = EnvParserUtil.parse('x\n'.repeat(300), 5);
    expect(capped.errors).toHaveLength(5);
  });
});

describe('ContentCompareService ENV rules', () => {
  it('compares string values and colors top-level keys per side', () => {
    const result = compareEnv(
      '# c\nexport A=1\nB=2\nONLY_LEFT=x\n\nSAME="s"',
      'A=1\nB=3\nONLY_RIGHT=y\nSAME=s',
    );

    expect(result.stats).toEqual({ added: 1, removed: 1, modified: 1 });
    expect(findNode(result.tree, '$.B')).toMatchObject({
      status: 'modified',
      leftDisplay: '"2"',
      rightDisplay: '"3"',
    });
    expect(findNode(result.tree, '$.A')?.leftDisplay).toBe('"1"');
    expect(result.leftText).toBe('# c\nexport A=1\nB=2\nONLY_LEFT=x\n\nSAME="s"');
    expect(result.segments.left).toEqual([
      { text: '# c\nexport A=1\n', status: null },
      { text: 'B=2', status: 'modified' },
      { text: '\n', status: null },
      { text: 'ONLY_LEFT=x', status: 'removed' },
      { text: '\n\nSAME="s"', status: null },
    ]);
    expect(result.segments.right).toEqual([
      { text: 'A=1\n', status: null },
      { text: 'B=3', status: 'modified' },
      { text: '\n', status: null },
      { text: 'ONLY_RIGHT=y', status: 'added' },
      { text: '\nSAME=s', status: null },
    ]);
  });

  it('ignores key order and never emits an unchanged status', () => {
    const result = compareEnv('B=2\nA=1', 'A=1\nB=2');

    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 0 });
    expect(result.segments.left).toEqual([{ text: 'B=2\nA=1', status: null }]);
    expect(result.segments.right).toEqual([{ text: 'A=1\nB=2', status: null }]);
  });

  it('keeps BOM and mixed CRLF, CR and LF byte-for-byte and maps keys on every line', () => {
    const left = `${BOM}A=1\r\nB=2\rC=3\nD=4\r\n`;
    const right = `${BOM}A=1\r\nB=9\rC=3\nE=5\r\n`;
    const result = compareEnv(left, right);

    expect(result.leftText).toBe(left);
    expect(result.rightText).toBe(right);
    expect(result.segments.left).toEqual([
      { text: `${BOM}A=1\r\n`, status: null },
      { text: 'B=2', status: 'modified' },
      { text: '\rC=3\n', status: null },
      { text: 'D=4', status: 'removed' },
      { text: '\r\n', status: null },
    ]);
    expect(result.segments.right).toEqual([
      { text: `${BOM}A=1\r\n`, status: null },
      { text: 'B=9', status: 'modified' },
      { text: '\rC=3\n', status: null },
      { text: 'E=5', status: 'added' },
      { text: '\r\n', status: null },
    ]);
  });

  it.each(['\n', '\r\n', '\r'])('joins segments back to the original for %j line breaks', (eol) => {
    const left = ['# head', 'A=1', '', 'B=2', 'C=3'].join(eol);
    const right = ['A=2', 'B=2', '', 'D=4', ''].join(eol);
    const result = compareEnv(left, right);

    expect(joinSegments(result.segments.left)).toBe(left);
    expect(joinSegments(result.segments.right)).toBe(right);
    expect(result.segments.left.find((segment) => segment.status === 'modified')?.text).toBe('A=1');
    expect(result.segments.left.find((segment) => segment.status === 'removed')?.text).toBe('C=3');
    expect(result.segments.right.find((segment) => segment.status === 'added')?.text).toBe('D=4');
    expect(
      [...result.segments.left, ...result.segments.right].every((segment) =>
        [null, 'added', 'removed', 'modified'].includes(segment.status),
      ),
    ).toBe(true);
  });

  it('keeps special ENV keys comparable', () => {
    const result = compareEnv(
      '__proto__=safe\nconstructor=value',
      '__proto__=other\nconstructor=value',
    );

    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 1 });
    expect(findNode(result.tree, '$.__proto__')?.status).toBe('modified');
    expect(({} as Record<string, unknown>).safe).toBeUndefined();
  });

  it('accepts normalized JSON objects on either side and keeps their original text', () => {
    const jsonSide = '  {"B":{"x":1},"A":"1"}';
    const result = compareEnv('A=1\nB=2', jsonSide);

    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 1 });
    expect(result.rightText).toBe(jsonSide);
    expect(result.segments.right).toEqual([{ text: jsonSide, status: null }]);
    expect(findNode(result.tree, '$.B')).toMatchObject({
      status: 'modified',
      leftDisplay: '"2"',
      rightDisplay: '{ 1 个键 }',
    });
    expect(result.segments.left).toEqual([
      { text: 'A=1\n', status: null },
      { text: 'B=2', status: 'modified' },
    ]);

    const both = compareEnv('{"b":1,"a":2}', '{"a":2,"b":3}');
    expect(both.segments.left).toEqual([{ text: '{"b":1,"a":2}', status: null }]);
    expect(both.stats.modified).toBe(1);
  });

  it('reports invalid normalized JSON without echoing it', () => {
    const error = catchException({ format: 'env', left: '{"SECRETKEY":', right: 'A=1' });

    expect(error.errors?.left.map((item) => item.code)).toEqual(['INVALID_JSON']);
    expect(error.errors?.left[0].message).toContain('规范化 JSON');
    expect(JSON.stringify(error.errors)).not.toContain('SECRETKEY');
  });
});

describe('content compare resource limits', () => {
  const nest = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);

  it('limits input length to 500000 UTF-16 characters', () => {
    const tooLong = catchException({ format: 'json', left: 'a'.repeat(500_001), right: '1' });
    expect(tooLong.errors?.left.map((item) => item.code)).toEqual(['TEXT_TOO_LONG']);

    const atLimit = JSON.stringify('x'.repeat(CONTENT_COMPARE_LIMITS.maxTextLength - 2));
    expect(atLimit).toHaveLength(CONTENT_COMPARE_LIMITS.maxTextLength);
    expect(compareJson(atLimit, atLimit).stats.modified).toBe(0);
  });

  it('limits container depth iteratively before recursive comparison', () => {
    expect(compareJson(nest(64), nest(64)).stats.modified).toBe(0);

    const error = catchException({ format: 'json', left: nest(65), right: '1' });
    expect(error.errors?.left.map((item) => item.code)).toEqual(['DEPTH_LIMIT_EXCEEDED']);
    expect(error.errors?.right).toEqual([]);

    const huge = nest(CONTENT_COMPARE_LIMITS.maxTextLength / 2);
    expect(catchException({ format: 'json', left: huge, right: huge }).errors?.right[0].code).toBe(
      'DEPTH_LIMIT_EXCEEDED',
    );
  });

  it('limits node count per side for JSON and ENV', () => {
    const items = (count: number) =>
      JSON.stringify(Array.from({ length: count }, (_, index) => index));
    expect(compareJson(items(9_999), items(9_999)).stats.modified).toBe(0);
    const error = catchException({ format: 'json', left: items(10_000), right: items(10_000) });
    expect(error.errors?.left[0].code).toBe('NODE_LIMIT_EXCEEDED');
    expect(error.errors?.right[0].code).toBe('NODE_LIMIT_EXCEEDED');

    const envKeys = Array.from({ length: 10_000 }, (_, index) => `K${index}=1`).join('\n');
    expect(
      catchException({ format: 'env', left: envKeys, right: 'A=1' }).errors?.left[0].code,
    ).toBe('NODE_LIMIT_EXCEEDED');
  });

  it('limits path length for keys and identity paths', () => {
    const longKey = (length: number) => `{"${'k'.repeat(length)}":1}`;
    expect(compareJson(longKey(4_094), longKey(4_094)).stats.modified).toBe(0);
    expect(
      catchException({ format: 'json', left: longKey(4_095), right: '{}' }).errors?.left[0].code,
    ).toBe('PATH_TOO_LONG');

    const longId = `[{"id":"${'x'.repeat(4_100)}"}]`;
    const error = catchException({ format: 'json', left: longId, right: longId });
    expect(error.getStatus()).toBe(400);
    expect(error.errors?.left[0].code).toBe('PATH_TOO_LONG');
    expect(error.errors?.right[0].code).toBe('PATH_TOO_LONG');
    expect(JSON.stringify(error.errors)).not.toContain('xxxx');
  });

  it('caps errors at 100 per side', () => {
    const error = catchException({ format: 'env', left: 'bad\n'.repeat(250), right: 'A=1' });

    expect(error.errors?.left).toHaveLength(CONTENT_COMPARE_LIMITS.maxErrors);
  });

  it('rejects a long ancestor key with a wide array by output budget as 413', () => {
    const wide = `{"${'k'.repeat(4_000)}":${JSON.stringify(Array.from({ length: 5_000 }, (_, i) => i))}}`;
    const error = catchException({ format: 'json', left: wide, right: wide });

    expect(error.getStatus()).toBe(413);
    expect(error.errors).toBeUndefined();
  });

  it('accumulates the budget while building nodes and rejects before exceeding it far', () => {
    const limit = 100_000;
    const budget = new OutputBudgetUtil(limit);
    const wide = JSON.parse(
      `{"${'k'.repeat(4_000)}":${JSON.stringify(Array.from({ length: 5_000 }, (_, i) => i))}}`,
    );

    expect(() => JsonCompareUtil.compare({ left: wide, right: wide, budget })).toThrow(
      ContentCompareException,
    );
    expect(budget.used).toBeGreaterThan(limit);
    expect(budget.used).toBeLessThan(limit + 10_000);
  });

  it('accumulates the budget while writing segments', () => {
    const budget = new OutputBudgetUtil(1_000_000);
    const value = JSON.parse(
      JSON.stringify(Array.from({ length: 2_000 }, (_, i) => ({ id: i, text: 'x'.repeat(50) }))),
    );
    const { root } = JsonCompareUtil.compare({ left: value, right: [], budget });
    const tight = new OutputBudgetUtil(5_000);

    expect(() => JsonSegmentUtil.serialize({ root, side: 'left', budget: tight })).toThrow(
      ContentCompareException,
    );
    expect(tight.used).toBeGreaterThan(5_000);
    expect(tight.used).toBeLessThan(5_000 + 600);
  });

  it('counts escaped and multi-byte output conservatively', () => {
    const budget = new OutputBudgetUtil(100);
    budget.addText('é'); // 2
    budget.addText('中'); // 3
    budget.addText('\u0001'); // 6
    budget.addText('😀'); // 4
    budget.addText('\ud800'); // lone surrogate, 6
    budget.addText('"\\'); // 4
    expect(budget.used).toBe(25);
  });

  it('does not backtrack on very long blank runs in ENV lines', () => {
    const started = Date.now();
    const result = compareEnv(`A=x${' '.repeat(400_000)}y\nB=${' '.repeat(50_000)}`, 'A=x');
    const invalid = catchException({
      format: 'env',
      left: `export${' '.repeat(100_000)}A B=1`,
      right: 'A=1',
    });

    expect(result.stats.modified).toBe(1);
    expect(invalid.errors?.left[0].code).toBe('INVALID_KEY');
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('content compare path uniqueness', () => {
  it('keeps dotted keys and nested keys on distinct paths', () => {
    const left = '{"a.b":{"top":1},"a":{"b":{"nested":2}}}';
    const right = '{"a.b":{"top":2},"a":{"b":{"nested":3}}}';
    const result = compareJson(left, right);
    const nodes = collectNodes(result.tree);

    expect(new Set(nodes.map((node) => node.path)).size).toBe(nodes.length);
    expect(findNode(result.tree, '$["a.b"].top')?.rightDisplay).toBe('2');
    expect(findNode(result.tree, '$.a.b.nested')?.rightDisplay).toBe('3');
    expect(result.stats.modified).toBe(2);
  });

  it('uses JSON string brackets for keys that are not plain identifiers', () => {
    const keys = [
      'a.b',
      'x y',
      'q"uote',
      '[0]',
      ']',
      '10',
      '',
      'é',
      'a-b',
      '$',
      'back' + String.fromCharCode(92) + 'slash',
    ];
    const object = Object.fromEntries([...keys, 'plain', '__proto__'].map((key) => [key, 1]));
    const text = JSON.stringify(object);
    const result = compareJson(text, text);
    const paths = collectNodes(result.tree).map((node) => node.path);

    for (const key of keys) expect(paths).toContain(`$[${JSON.stringify(key)}]`);
    expect(paths).toContain('$.plain');
    expect(paths).toContain('$.__proto__');
    expect(new Set(paths).size).toBe(paths.length);

    const mixed = compareJson('{"list":[1],"m":{"0":1}}', '{"list":[1],"m":{"0":2}}');
    expect(findNode(mixed.tree, '$.list[0]')?.status).toBe('unchanged');
    expect(findNode(mixed.tree, '$.m["0"]')?.status).toBe('modified');
  });

  it('measures bracket paths by their escaped length before comparison', () => {
    const keyed = (key: string) => JSON.stringify({ [key]: 1 });
    // $["..."] 共 key 长度 + 5 个字符
    expect(compareJson(keyed('.'.repeat(4_091)), keyed('.'.repeat(4_091))).stats.modified).toBe(0);
    expect(
      catchException({ format: 'json', left: keyed('.'.repeat(4_092)), right: '{}' }).errors
        ?.left[0].code,
    ).toBe('PATH_TOO_LONG');
    // 引号转义后长度翻倍，原始键长仍低于上限也必须拒绝
    expect(
      catchException({ format: 'json', left: keyed('"'.repeat(2_100)), right: '{}' }).errors
        ?.left[0].code,
    ).toBe('PATH_TOO_LONG');
  });
});

describe('content compare normalized text boundary', () => {
  const MAX = CONTENT_COMPARE_LIMITS.maxTextLength;
  const objectOf = (length: number) => JSON.stringify({ a: 'x'.repeat(length) });

  it('falls back to compact layout when the pretty text would exceed the limit', () => {
    const json = objectOf(MAX - 8);
    expect(json).toHaveLength(MAX);
    const result = compareJson(json, json);

    expect(result.leftText).toBe(json);
    expect(result.rightText).toBe(json);
    expect(result.leftText).toHaveLength(MAX);
    expect(joinSegments(result.segments.left)).toBe(result.leftText);
    expect(joinSegments(result.segments.right)).toBe(result.rightText);
    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 0 });
  });

  it('keeps pretty layout up to exactly the limit', () => {
    const result = compareJson(objectOf(MAX - 13), objectOf(MAX - 13));

    expect(result.leftText).toHaveLength(MAX);
    expect(result.leftText.startsWith('{\n  "a": "')).toBe(true);
    expect(compareJson(objectOf(MAX - 12), objectOf(MAX - 12)).leftText).toHaveLength(MAX - 4);
  });

  it('chooses the layout per side and keeps results resubmittable and swap-stable', () => {
    const big = objectOf(MAX - 8);
    const forward = compareJson(big, '{"a":"y"}');

    expect(forward.leftText).toBe(big);
    expect(forward.rightText).toBe('{\n  "a": "y"\n}');
    expect(forward.stats.modified).toBe(1);

    const again = compareJson(forward.leftText, forward.rightText);
    expect(again.leftText).toBe(forward.leftText);
    expect(again.rightText).toBe(forward.rightText);

    const swapped = compareJson(forward.rightText, forward.leftText);
    expect(swapped.leftText).toBe(forward.rightText);
    expect(swapped.rightText).toBe(forward.leftText);
    expect(swapped.stats).toEqual(forward.stats);
    expect(compareJson(swapped.leftText, swapped.rightText).rightText).toBe(forward.leftText);
  });

  it('highlights compact segments and keeps text equal to joined segments', () => {
    const doc = (flag: number) => `{"a":"${'x'.repeat(MAX - 20)}","b":${flag}}`;
    const result = compareJson(doc(1), doc(2));

    expect(result.leftText).not.toContain('\n');
    expect(result.leftText).toBe(doc(1));
    expect(result.segments.left).toEqual(
      expect.arrayContaining([
        { text: '"b"', status: 'modified' },
        { text: ':', status: null },
        { text: '1', status: 'modified' },
      ]),
    );
    expect(joinSegments(result.segments.left)).toBe(result.leftText);
    expect(joinSegments(result.segments.right)).toBe(result.rightText);
  });

  it('accounts for lone surrogates expanding to six characters', () => {
    const lone = (count: number) => `{"a":"${'\ud800'.repeat(count)}"}`;
    const fits = compareJson(lone(83_332), lone(83_332));

    expect(fits.leftText).toHaveLength(MAX);
    expect(fits.leftText).toContain(String.fromCharCode(92) + 'ud800');
    expect(joinSegments(fits.segments.left)).toBe(fits.leftText);
    expect(compareJson(fits.leftText, fits.rightText).leftText).toBe(fits.leftText);

    const error = catchException({ format: 'json', left: lone(83_333), right: '{}' });
    expect(error.getStatus()).toBe(413);
    expect(error.errors).toBeUndefined();
    expect(error.message).not.toContain('ud800');
  });

  it('rejects before writing segments when even the compact text cannot be resubmitted', () => {
    const budget = new OutputBudgetUtil();
    const value = JSON.parse(`{"a":"${'\ud800'.repeat(83_333)}"}`);
    const { root } = JsonCompareUtil.compare({ left: value, right: value, budget });
    const used = budget.used;

    expect(() => JsonSegmentUtil.serialize({ root, side: 'left', budget })).toThrow(
      ContentCompareException,
    );
    expect(budget.used).toBe(used);
  });
});
