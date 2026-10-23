import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const loadScript = createRequire(__filename);
const Data = loadScript(resolve(__dirname, '../../public/js/workflow-data.js'));
const {
  LIMITS,
  isJsonValue,
  assertJsonValue,
  parseJson,
  readPath,
  renderTemplate,
  createDateRange,
  createCellRange,
  validateCellValues,
  parseCellRange,
} = Data;

/** 构造固定深度的 JSON 值，避免依赖实现内部校验步骤。 */
function nested(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe('workflow bounded pure JSON', () => {
  it.each([null, true, false, '', 0, -1, 0.5, { list: [{ name: '中文' }, null, false] }])(
    'accepts and round-trips valid JSON %j',
    (value) => {
      expect(isJsonValue(value)).toBe(true);
      expect(assertJsonValue(value)).toBe(value);
      expect(parseJson(JSON.stringify(value))).toEqual(value);
    },
  );

  it('retains literal prototype keys as ordinary data but never pollutes any prototype', () => {
    const value = parseJson('{"__proto__":{"polluted":true},"constructor":"plain"}');
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(value.constructor).toBe('plain');
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(() => readPath(value, '__proto__.polluted')).toThrow('原型');
  });

  it.each(
    [
      undefined,
      () => true,
      Symbol('x'),
      1n,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      new Date(),
      new Map(),
      [undefined],
      Array(1),
    ].map((value) => ({ value })),
  )('rejects non-JSON, non-finite, unsafe or lossy data', ({ value }) =>
    expect(isJsonValue(value)).toBe(false),
  );

  it('rejects cycles, getters, symbol fields and non-JSON array properties without invoking code', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const getter = vi.fn(() => 'never');
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    const array = Object.assign([1], { extra: 2 });
    expect([cyclic, accessor, array, { [Symbol('key')]: 1 }].map(isJsonValue)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(getter).not.toHaveBeenCalled();
  });

  it('enforces depth, total nodes and UTF-8 budgets independently', () => {
    expect(isJsonValue(nested(LIMITS.jsonDepth))).toBe(true);
    expect(isJsonValue(nested(LIMITS.jsonDepth + 1))).toBe(false);
    expect(isJsonValue(Array.from({ length: LIMITS.jsonNodes }, () => null))).toBe(false);
    expect(isJsonValue(['中'.repeat(200_000), '中'.repeat(200_000)])).toBe(false);
    expect(() => parseJson(' '.repeat(LIMITS.textLength + 1))).toThrow('大小');
    expect(() => parseJson('"' + '中'.repeat(400_000) + '"')).toThrow('大小');
    expect(() => parseJson('1e400')).toThrow('数值');
    expect(() => parseJson('9007199254740993')).toThrow('安全');
  });

  it('does not expose invalid drafts or parser details in JSON errors', () => {
    const parse = vi.fn(() => parseJson('{"private-draft-secret":'));
    expect(parse).toThrow('JSON 原文不是有效 JSON，请检查输入。');
    expect((parse.mock.results[0].value as Error).message).not.toContain('private-draft-secret');
  });
});

describe('workflow own-property paths', () => {
  const records = [
    { author: { name: 'Alice' }, list: [{ tag: 'FEAT' }], n: 0, flag: false },
    { author: { name: 'bob' }, list: [], n: 2, flag: true },
    { author: { name: '' }, list: [], n: null, flag: false },
    { list: [], flag: false },
  ];

  it('reads nested and array paths without traversing inherited properties or getters', () => {
    expect(readPath(records[0], 'list[0].tag')).toBe('FEAT');
    expect(readPath(records, '[0].author.name')).toBe('Alice');
    expect(readPath(records, '0.author.name')).toBe('Alice');
    expect(readPath(records[0], '')).toBe(records[0]);
    expect(readPath(Object.create({ inherited: 'no' }), 'inherited')).toBeUndefined();
    const getter = vi.fn();
    expect(() => readPath(Object.defineProperty({}, 'value', { get: getter }), 'value')).toThrow(
      '动态',
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['__proto__.x', '原型字段'],
    ['author.constructor', '原型字段'],
    ['prototype', '原型字段'],
    ['list[constructor]', '只支持自有字段和数字数组下标'],
    ['list[-1]', '只支持自有字段和数字数组下标'],
    ['a..b', '只支持自有字段和数字数组下标'],
    ['a()', '只支持自有字段和数字数组下标'],
  ])('rejects unsafe path %s', (path, message) => {
    expect(() => readPath(records, path)).toThrow(message);
  });
});

describe('workflow literal templates', () => {
  it('formats nested JSON and optional inputs without evaluating code or replacement metacharacters', () => {
    const result = renderTemplate('范围 {{context.start}}\n{{data[0].name}}|{{data}}|{{text}}', {
      context: { start: '2026-10-01' },
      data: [{ name: '$& ${globalThis.hacked=true}' }],
      text: '<script>alert(1)</script>',
    });
    expect(result).toBe(
      '范围 2026-10-01\n$& ${globalThis.hacked=true}|[{"name":"$& ${globalThis.hacked=true}"}]|<script>alert(1)</script>',
    );
    expect(renderTemplate('{{data}}', { data: null })).toBe('null');
    expect(renderTemplate('{{data}}', { data: false })).toBe('false');
    expect(renderTemplate('静态模板')).toBe('静态模板');
  });

  it.each([
    ['{{unknown}}', '不支持表达式'],
    ['{{data.missing}}', '引用的输入或字段不存在'],
    ['{{text}}', '引用的输入或字段不存在'],
    ['{{data.constructor}}', '原型字段'],
    ['{{data.__proto__}}', '原型字段'],
    ['{{data.value || alert(1)}}', '只支持自有字段和数字数组下标'],
    ['{{globalThis.process}}', '不支持表达式'],
    ['{{text.length}}', '不支持表达式'],
  ])('fails unavailable or unsafe reference %s', (template, message) => {
    expect(() => renderTemplate(template, { data: { value: 'ok' } })).toThrow(message);
  });

  it.each([['a"b\nc\\d'], ['["a"],["b"]'], [[1, 'two', false, null]], [null], [0], [false]])(
    'serializes explicit JSON references without interpreting strings as JSON fragments',
    (value) => {
      const rendered = renderTemplate('[{{json:data.0}}]', { data: [value] });
      expect(JSON.parse(rendered)).toEqual([value]);
      expect(renderTemplate('{{json:text}}', { text: 'a"b\nc\\d' })).toBe(
        JSON.stringify('a"b\nc\\d'),
      );
      expect(renderTemplate('{{json:context.name}}', { context: { name: 'Alice' } })).toBe(
        '"Alice"',
      );
    },
  );

  it.each([
    ['{{json:unknown}}', '不支持表达式'],
    ['{{json:data.missing}}', '引用的输入或字段不存在'],
    ['{{json:data.constructor}}', '原型字段'],
    ['{{json:data.value || alert(1)}}', '只支持自有字段和数字数组下标'],
    ['{{json:text.length}}', '不支持表达式'],
    ['{{json:}}', '不支持表达式'],
  ])(
    'keeps JSON serialization references inside the existing safe path boundary',
    (template, message) => {
      expect(() => renderTemplate(template, { data: { value: 'ok' } })).toThrow(message);
    },
  );

  it('requires own inputs and bounds the assembled output rather than truncating', () => {
    expect(() => renderTemplate('{{data}}', Object.create({ data: 'inherited' }))).toThrow(
      '不存在',
    );
    expect(() =>
      renderTemplate('{{text}}{{text}}', { text: 'x'.repeat(LIMITS.textLength) }),
    ).toThrow('输出');
    expect(() => renderTemplate('{{json:text}}', { text: 'x'.repeat(LIMITS.textLength) })).toThrow(
      '输出',
    );
    expect(renderTemplate('{{text}}', { text: 'x'.repeat(LIMITS.textLength) })).toHaveLength(
      LIMITS.textLength,
    );
  });
});

describe('workflow explicit local date ranges', () => {
  it('computes Monday through Sunday for this and last week across month/year boundaries', () => {
    const now = new Date(2026, 0, 1, 12, 30);
    const current = createDateRange({ period: 'this-week' }, now);
    const previous = createDateRange({ period: 'last-week' }, now);
    expect(current).toMatchObject({ startDate: '2025-12-29', endDate: '2026-01-04' });
    expect(previous).toMatchObject({ startDate: '2025-12-22', endDate: '2025-12-28' });
    expect(new Date(current.since).getHours()).toBe(0);
    expect(new Date(current.until).getHours()).toBe(23);
    expect(new Date(current.until).getMilliseconds()).toBe(999);
    expect(now.getDate()).toBe(1);
    expect(createDateRange({ period: 'this-week' }, new Date(2026, 9, 18, 23))).toMatchObject({
      startDate: '2026-10-12',
      endDate: '2026-10-18',
    });
    expect(createDateRange({ period: 'this-week' }, new Date(2026, 9, 19))).toMatchObject({
      startDate: '2026-10-19',
      endDate: '2026-10-25',
    });
  });

  it('normalizes custom explicit dates and timezone timestamps', () => {
    const week = createDateRange({ period: 'custom', since: '2026-08-24', until: '2026-08-28' });
    expect(week).toMatchObject({
      start: { year: 2026, month: 8, day: 24 },
      end: { year: 2026, month: 8, day: 28 },
    });
    expect(createDateRange({ period: 'last-week' }, new Date(2026, 0, 2))).toMatchObject({
      start: { year: 2025, month: 12, day: 22 },
      end: { year: 2025, month: 12, day: 28 },
    });
    const sameDay = createDateRange({ period: 'custom', since: '2024-02-29', until: '2024-02-29' });
    expect(sameDay).toMatchObject({ startDate: '2024-02-29', endDate: '2024-02-29' });
    expect(new Date(sameDay.until).getHours()).toBe(23);
    const iso = createDateRange({
      period: 'custom',
      since: '2026-10-21T08:00:00+08:00',
      until: '2026-10-22T08:00:00+08:00',
    });
    expect(iso.since).toBe('2026-10-21T00:00:00.000Z');
    expect(iso.until).toBe('2026-10-22T00:00:00.000Z');
  });

  it.each([
    [{ period: 'custom', since: '', until: '' }, '时间必须包含明确时区'],
    [{ period: 'custom', since: '2025-02-29', until: '2025-03-02' }, '日期不存在'],
    [{ period: 'custom', since: '2026-01-01T24:00:00Z', until: '2026-01-03' }, '日期时间无效'],
    [
      { period: 'custom', since: '2026-01-01T00:00:00', until: '2026-01-03' },
      '时间必须包含明确时区',
    ],
    [{ period: 'custom', since: '2026-03-01', until: '2026-02-01' }, '开始时间必须早于结束时间'],
    [
      { period: 'custom', since: '2026-01-01T00:00:00Z', until: '2026-01-01T00:00:00Z' },
      '开始时间必须早于结束时间',
    ],
    [{ period: 'weekly-business-rule' }, '日期范围周期无效'],
  ])('rejects invalid or implicit date configuration %j', (config, message) =>
    expect(() => createDateRange(config)).toThrow(message),
  );
});

describe('workflow explicit cell matrices', () => {
  it('derives range from the actual start column, row and rectangular matrix, including column rollover', () => {
    const values = [
      ['=SUM(A1:A2)', 1, false],
      [null, '中文', 2.5],
    ];
    expect(createCellRange({ startColumn: 'Z', row: 42, values })).toBe('Z42:AB43');
    expect(createCellRange({ startColumn: 'A', row: 1, values: [[true]] })).toBe('A1:A1');
    expect(validateCellValues(values)).toEqual({ rows: 2, columns: 3, cells: 6 });
    expect(parseCellRange('A1:ZZ1000000')).toEqual({
      startColumn: 1,
      endColumn: 702,
      startRow: 1,
      endRow: 1_000_000,
    });
    expect(values[0][0]).toBe('=SUM(A1:A2)');
  });

  it.each([
    { values: [], message: '非空二维矩阵' },
    { values: [[]], message: '非空二维矩阵' },
    { values: [[1], [2, 3]], message: '每一行的列数必须相同' },
    { values: [[{}]], message: '仅支持文本、数字、布尔值或 null' },
    { values: [[Infinity]], message: 'JSON 数值必须有限' },
    { values: [['x'.repeat(8001)]], message: '单元格文本超过长度限制' },
    { values: Array.from({ length: 201 }, () => [1]), message: '非空二维矩阵' },
    { values: [Array(51).fill(1)], message: '非空二维矩阵' },
    { values: Array.from({ length: 41 }, () => Array(50).fill(1)), message: '单元格数量超过限制' },
  ])('rejects malformed or over-budget matrices without truncation', ({ values, message }) =>
    expect(() => validateCellValues(values)).toThrow(message),
  );

  it('bounds serialized UTF-8, absolute coordinates and explicit start columns', () => {
    expect(() => validateCellValues([Array(50).fill('中'.repeat(8000))])).toThrow(
      'JSON 数据超过大小限制',
    );
    for (const [options, message] of [
      [{ startColumn: 'ZZ', row: 1, values: [[1, 2]] }, '写入矩阵超出工作表坐标范围'],
      [{ startColumn: 'A', row: 1_000_000, values: [[1], [2]] }, '写入矩阵超出工作表坐标范围'],
      [{ startColumn: '', row: 1, values: [[1]] }, '起始列必须是'],
      [{ startColumn: 'C:G', row: 1, values: [[1]] }, '起始列必须是'],
      [{ startColumn: 'a', row: 1, values: [[1]] }, '起始列必须是'],
      [{ startColumn: 'A', row: 0, values: [[1]] }, '有效的绝对行号'],
    ] as const)
      expect(() => createCellRange(options)).toThrow(message);
    for (const [range, message] of [
      ['sheet!A1:B2', '绝对矩形，不含工作表标识'],
      ['A0:B1', '绝对矩形，不含工作表标识'],
      ['B2:A1', '范围顺序或坐标无效'],
      ['A1:AAA2', '单元格列超出范围'],
      ['A1:B1000001', '范围顺序或坐标无效'],
    ])
      expect(() => parseCellRange(range)).toThrow(message);
  });
});
