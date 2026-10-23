import { describe, expect, it, vi } from 'vitest';
import { FeishuSheetGatewayService } from '../client/feishu/feishu-sheet-gateway.service';
import { parseFeishuSheetUrl } from '../client/feishu/feishu-sheet-url.util';
import type { ExternalHttpClientService } from '../client/external/external-http-client.service';
import type {
  FeishuFindRowDto,
  FeishuWriteCellsDto,
} from '../modules/workflow-capabilities/dto/feishu-sheet.dto';
import { FeishuSheetCapabilityService } from '../modules/workflow-capabilities/feishu-sheet-capability.service';
import {
  columnToIndex,
  matrixAlreadyWritten,
  toWritableCell,
} from '../modules/workflow-capabilities/feishu-sheet-range.util';
import { WorkflowCapabilityException } from '../modules/workflow-capabilities/workflow-capability.exception';

const APP_SECRET = 'APP_SECRET_9f3a7c';
const WIKI_URL = 'https://example.feishu.cn/wiki/test-node?sheet=sheet1';
const SHEETS_URL = 'https://example.feishu.cn/sheets/shtTOKEN?sheet=sheet1';

interface UpstreamCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: any;
  headers: Record<string, string>;
}

/** 按飞书路径返回受控响应，并记录每次上游调用。 */
function setup(
  routes: Partial<{
    token: (call: UpstreamCall) => unknown;
    wiki: (call: UpstreamCall) => unknown;
    read: (call: UpstreamCall) => unknown;
    meta: (call: UpstreamCall) => unknown;
    write: (call: UpstreamCall) => unknown;
  }> = {},
) {
  const calls: UpstreamCall[] = [];
  const ok = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
  const request = vi.fn(async (options: any) => {
    const call: UpstreamCall = {
      method: options.method,
      path: decodeURIComponent(options.url.pathname),
      query: Object.fromEntries(options.url.searchParams),
      body: options.body === undefined ? undefined : JSON.parse(options.body),
      headers: options.headers,
    };
    expect(options.url.origin).toBe('https://open.feishu.cn');
    calls.push(call);
    if (call.path.includes('/auth/v3/')) {
      return routes.token?.(call) ?? ok({ code: 0, tenant_access_token: 't-access', expire: 7200 });
    }
    if (call.path.includes('/wiki/v2/')) {
      return (
        routes.wiki?.(call) ??
        ok({ code: 0, data: { node: { obj_type: 'sheet', obj_token: 'shtTOKEN' } } })
      );
    }
    if (call.path.endsWith('/metainfo')) {
      return routes.meta?.(call) ?? ok({ code: 0, data: { sheets: [{ sheetId: 'sheet1' }] } });
    }
    if (call.method === 'PUT') {
      return routes.write?.(call) ?? ok({ code: 0, data: { updatedCells: 2 } });
    }
    return routes.read?.(call) ?? ok({ code: 0, data: { valueRange: { values: [] } } });
  });
  const gateway = new FeishuSheetGatewayService({
    request,
  } as unknown as ExternalHttpClientService);
  return { calls, request, service: new FeishuSheetCapabilityService(gateway) };
}

const rows = (values: unknown[][]) => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ code: 0, data: { valueRange: { values } } }),
});
const httpError = (status: number, body: unknown = {}) => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});

function find(overrides: Partial<FeishuFindRowDto> = {}): FeishuFindRowDto {
  return {
    wikiUrl: WIKI_URL,
    range: 'A10:C20',
    matches: [{ column: 'B', value: '张三', mode: 'equals' }],
    runtime: { appId: 'cli_app', appSecret: APP_SECRET },
    ...overrides,
  };
}

function write(overrides: Partial<FeishuWriteCellsDto> = {}): FeishuWriteCellsDto {
  return {
    wikiUrl: WIKI_URL,
    range: 'C12:D12',
    values: [['一', '二']],
    confirmed: true,
    runtime: { appId: 'cli_app', appSecret: APP_SECRET },
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

async function failure(promise: Promise<unknown>): Promise<WorkflowCapabilityException> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WorkflowCapabilityException);
  return error as WorkflowCapabilityException;
}

describe('parseFeishuSheetUrl', () => {
  it('parses wiki and sheets addresses on supported tenant domains', () => {
    expect(parseFeishuSheetUrl(WIKI_URL)).toEqual({
      type: 'wiki',
      token: 'test-node',
      sheetId: 'sheet1',
    });
    expect(parseFeishuSheetUrl(SHEETS_URL.replace('feishu.cn', 'larksuite.com'))).toEqual({
      type: 'sheets',
      token: 'shtTOKEN',
      sheetId: 'sheet1',
    });
  });

  it.each([
    'http://example.feishu.cn/wiki/test-node?sheet=sheet1',
    'https://example.feishu.cn/wiki/test-node',
    'https://example.feishu.cn/wiki/test-node?sheet=',
    'https://example.feishu.cn/wiki/test-node?sheet=a%20b',
    'https://example.feishu.cn/wiki/test-node?sheet=sheet1#frag',
    'https://example.feishu.cn:8443/wiki/test-node?sheet=sheet1',
    'https://user:pass@example.feishu.cn/wiki/test-node?sheet=sheet1',
    'https://example.feishu.cn.evil.com/wiki/test-node?sheet=sheet1',
    'https://evil.com/wiki/test-node?sheet=sheet1',
    'https://example.feishu.cn/docx/test-node?sheet=sheet1',
    'https://example.feishu.cn/wiki/test-node/extra?sheet=sheet1',
    'https://example.feishu.cn/wiki/?sheet=sheet1',
    'not a url',
  ])('rejects %s', (value) => {
    expect(() => parseFeishuSheetUrl(value)).toThrow(WorkflowCapabilityException);
  });
});

describe('sheet range helpers', () => {
  it('converts column names and rejects columns beyond ZZ', () => {
    expect([
      columnToIndex('A'),
      columnToIndex('Z'),
      columnToIndex('AA'),
      columnToIndex('ZZ'),
    ]).toEqual([1, 26, 27, 702]);
    expect([columnToIndex('AAA'), columnToIndex('a'), columnToIndex('')]).toEqual([0, 0, 0]);
  });

  it('writes formula-like text as literals and leaves numbers and booleans intact', () => {
    expect(
      ['=SUM(1,1)', '+1', '-x', '@a', '\tx', '\rx', '普通', '', 'a=b'].map((value) =>
        toWritableCell(value),
      ),
    ).toEqual(["'=SUM(1,1)", "'+1", "'-x", "'@a", "'\tx", "'\rx", '普通', '', 'a=b']);
    expect([
      toWritableCell(-5),
      toWritableCell(0.5),
      toWritableCell(true),
      toWritableCell(null),
    ]).toEqual([-5, 0.5, true, '']);
  });

  it('recognizes already written matrices including omitted trailing cells', () => {
    expect(matrixAlreadyWritten([['一']], [['一', null]])).toBe(true);
    expect(matrixAlreadyWritten([['一', 'x']], [['一', '二']])).toBe(false);
    expect(matrixAlreadyWritten([['=A1']], [['=A1']])).toBe(true);
    expect(matrixAlreadyWritten([["'=A1"]], [['=A1']])).toBe(true);
    expect(matrixAlreadyWritten([[5]], [[5]])).toBe(true);
  });
});

describe('FeishuSheetCapabilityService.findRow', () => {
  it('resolves the wiki node, reads only the requested range and returns the absolute row', async () => {
    const { calls, service } = setup({
      read: () =>
        rows([
          ['日期', '姓名', '备注'],
          ['10-12', '李四', ''],
          ['10-12', ' 张三 ', 'x'],
        ]),
    });

    const result = await service.findRow(find(), signal());

    expect(result).toEqual({ wikiUrl: WIKI_URL, row: 12, sheetId: 'sheet1' });
    expect(
      calls.map((call) => `${call.method} ${call.path.split('/').slice(2, 5).join('/')}`),
    ).toEqual([
      'POST auth/v3/tenant_access_token',
      'GET wiki/v2/spaces',
      'GET sheets/v2/spreadsheets',
      'GET sheets/v2/spreadsheets',
    ]);
    expect(calls[3].path).toBe('/open-apis/sheets/v2/spreadsheets/shtTOKEN/metainfo');
    expect(calls[0].body).toEqual({ app_id: 'cli_app', app_secret: APP_SECRET });
    expect(calls[1].query).toEqual({ token: 'test-node' });
    expect(calls[2].path).toContain('/spreadsheets/shtTOKEN/values/sheet1!A10:C20');
    expect(calls[2].query).toMatchObject({ valueRenderOption: 'ToString' });
    expect(calls[2].headers.Authorization).toBe('Bearer t-access');
  });

  it('skips wiki resolution for direct sheets addresses', async () => {
    const { calls, service } = setup({ read: () => rows([['', '张三']]) });
    const result = await service.findRow(find({ wikiUrl: SHEETS_URL, range: 'A1:B2' }), signal());
    expect(result).toEqual({ wikiUrl: SHEETS_URL, row: 1, sheetId: 'sheet1' });
    expect(calls.some((call) => call.path.includes('/wiki/'))).toBe(false);
  });

  it('requires every condition to match and supports contains with rich text cells', async () => {
    const { service } = setup({
      read: () =>
        rows([
          ['a', '张三', '周报'],
          [
            'b',
            '张三',
            [
              { type: 'text', text: '月' },
              { type: 'text', text: '报' },
            ],
          ],
          ['c', '李四', '月报'],
        ]),
    });
    const result = await service.findRow(
      find({
        range: 'A1:C3',
        matches: [
          { column: 'B', value: '张三', mode: 'equals' },
          { column: 'C', value: '月', mode: 'contains' },
        ],
      }),
      signal(),
    );
    expect(result.row).toBe(2);
  });

  it('treats rows and columns omitted by Feishu as empty cells across the whole requested range', async () => {
    // 飞书省略尾部空行：A1:B2 中两行 B 列都为空，只有 A1 有内容，必须判为多匹配而不是第 1 行唯一
    const trailing = setup({ read: () => rows([['marker']]) });
    const ambiguous = await failure(
      trailing.service.findRow(
        find({ range: 'A1:B2', matches: [{ column: 'B', value: '', mode: 'equals' }] }),
        signal(),
      ),
    );
    expect(ambiguous.getStatus()).toBe(409);

    // 完全没有返回值时，所有行都视为空
    const none = setup({ read: () => rows([]) });
    const all = await failure(
      none.service.findRow(
        find({ range: 'A10:B12', matches: [{ column: 'A', value: '', mode: 'equals' }] }),
        signal(),
      ),
    );
    expect(all.getStatus()).toBe(409);

    // 被省略的尾部行可以是唯一的空行，行号仍按请求范围计算
    const unique = setup({ read: () => rows([['a', 'x'], ['b']]) });
    await expect(
      unique.service.findRow(
        find({ range: 'A5:B7', matches: [{ column: 'B', value: 'x', mode: 'equals' }] }),
        signal(),
      ),
    ).resolves.toMatchObject({ row: 5 });
    const emptyTail = setup({
      read: () =>
        rows([
          ['a', 'x'],
          ['b', 'y'],
        ]),
    });
    await expect(
      emptyTail.service.findRow(
        find({ range: 'A5:B7', matches: [{ column: 'A', value: '', mode: 'equals' }] }),
        signal(),
      ),
    ).resolves.toMatchObject({ row: 7 });
  });

  it('matches rows inside a vertically merged week cell by its top-left value', async () => {
    // A1:A3 合并为同一周，飞书只在 A1 返回值；第 2 行应按区域取值后命中
    const merged = (merges: unknown[]) =>
      setup({
        read: () =>
          rows([
            ['8.24-8.28', '张三'],
            [null, '黎君豪'],
            [null, '李四'],
            ['8.31-9.4', '黎君豪'],
          ]),
        meta: () => ({
          status: 200,
          headers: {},
          body: JSON.stringify({
            code: 0,
            data: { sheets: [{ sheetId: 'other' }, { sheetId: 'sheet1', merges }] },
          }),
        }),
      });
    const matches: FeishuFindRowDto['matches'] = [
      { column: 'A', value: '8.24-8.28', mode: 'contains' },
      { column: 'B', value: '黎君豪', mode: 'equals' },
    ];
    const week = [{ startRowIndex: 0, startColumnIndex: 0, rowCount: 3, columnCount: 1 }];
    await expect(
      merged(week).service.findRow(find({ range: 'A1:B200', matches }), signal()),
    ).resolves.toMatchObject({ row: 2 });
    // 没有合并信息时保持原行为：A2 为空，不会命中
    expect(
      (
        await failure(merged([]).service.findRow(find({ range: 'A1:B200', matches }), signal()))
      ).getStatus(),
    ).toBe(404);
    // 合并区域超出范围底部时只补齐范围内的行
    await expect(
      merged(week).service.findRow(find({ range: 'A1:B2', matches }), signal()),
    ).resolves.toMatchObject({ row: 2 });
  });

  it('rejects a range that cuts off the top-left cell of a merged region instead of treating it as empty', async () => {
    const { service } = setup({
      read: () => rows([[null, '黎君豪']]),
      meta: () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          data: {
            sheets: [
              {
                sheetId: 'sheet1',
                merges: [{ startRowIndex: 0, startColumnIndex: 0, rowCount: 3, columnCount: 1 }],
              },
            ],
          },
        }),
      }),
    });
    const error = await failure(
      service.findRow(
        find({ range: 'A2:B2', matches: [{ column: 'B', value: '黎君豪', mode: 'equals' }] }),
        signal(),
      ),
    );
    expect(error.getStatus()).toBe(422);
    expect(error.message).toContain('合并区域的首行和首列');
  });

  it.each([
    ['the linked sheet is missing', { sheets: [{ sheetId: 'other' }] }, 400],
    [
      'merges are malformed',
      {
        sheets: [
          {
            sheetId: 'sheet1',
            merges: [{ startRowIndex: -1, startColumnIndex: 0, rowCount: 1, columnCount: 1 }],
          },
        ],
      },
      502,
    ],
    ['sheets are missing', {}, 400],
  ])('fails clearly when %s in the sheet metadata', async (_name, data, status) => {
    const { service } = setup({
      read: () => rows([['a', '张三']]),
      meta: () => ({ status: 200, headers: {}, body: JSON.stringify({ code: 0, data }) }),
    });
    expect((await failure(service.findRow(find({ range: 'A1:B1' }), signal()))).getStatus()).toBe(
      status,
    );
  });

  it('only considers rows inside the requested range', async () => {
    const { service } = setup({
      read: () =>
        rows([
          ['a', 'x'],
          ['b', 'y'],
          ['c', '张三'],
        ]),
    });
    const error = await failure(service.findRow(find({ range: 'A1:B2' }), signal()));
    expect(error.getStatus()).toBe(404);
  });

  it('reports zero matches as 404 and multiple matches as 409 without echoing the searched value', async () => {
    const none = setup({ read: () => rows([['a', '李四']]) });
    const zero = await failure(none.service.findRow(find({ range: 'A1:B1' }), signal()));
    expect(zero.getStatus()).toBe(404);
    expect(zero.message).not.toContain('张三');

    const many = setup({
      read: () =>
        rows([
          ['a', '张三'],
          ['b', '张三'],
        ]),
    });
    const duplicate = await failure(many.service.findRow(find({ range: 'A1:B2' }), signal()));
    expect(duplicate.getStatus()).toBe(409);
  });

  it('rejects match columns outside the range, empty contains values and over-budget ranges', async () => {
    const outside = setup();
    expect(
      (
        await failure(
          outside.service.findRow(
            find({ range: 'A1:B2', matches: [{ column: 'C', value: 'x', mode: 'equals' }] }),
            signal(),
          ),
        )
      ).getStatus(),
    ).toBe(400);

    const empty = setup({ read: () => rows([['a', 'b']]) });
    expect(
      (
        await failure(
          empty.service.findRow(
            find({ range: 'A1:B2', matches: [{ column: 'A', value: '', mode: 'contains' }] }),
            signal(),
          ),
        )
      ).getStatus(),
    ).toBe(400);

    const budget = setup();
    for (const range of ['A1:A501', 'A1:BA2', 'A1:AX500', 'B2:A3', 'A1:A2000000']) {
      const error = await failure(budget.service.findRow(find({ range }), signal()));
      expect([400, 422]).toContain(error.getStatus());
    }
    expect(budget.request).not.toHaveBeenCalled();
  });

  it('fails clearly when the wiki node is not a spreadsheet', async () => {
    const { service } = setup({
      wiki: () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 0, data: { node: { obj_type: 'docx', obj_token: 'x' } } }),
      }),
    });
    expect((await failure(service.findRow(find(), signal()))).getStatus()).toBe(400);
  });

  it('turns upstream failures into fixed messages with stage, status and numeric code only', async () => {
    const { service } = setup({
      token: () => httpError(400, { code: 10014, msg: `app secret invalid ${APP_SECRET}` }),
    });
    const error = await failure(service.findRow(find(), signal()));
    expect(error.getStatus()).toBe(502);
    expect(error.message).toContain('10014');
    expect(error.message).toContain('获取访问令牌');
    expect(error.message).not.toContain(APP_SECRET);
    expect(error.message).not.toContain('app secret invalid');
  });

  it('treats business error codes in HTTP 200 responses as failures', async () => {
    const { service } = setup({
      read: () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 1310213, msg: 'permission' }),
      }),
    });
    const error = await failure(service.findRow(find(), signal()));
    expect(error.message).toContain('1310213');
    expect(error.message).not.toContain('permission');
  });

  it('rejects invalid wiki urls before any network access', async () => {
    const { service, request } = setup();
    await failure(
      service.findRow(find({ wikiUrl: 'https://example.feishu.cn/wiki/test-node' }), signal()),
    );
    await failure(
      service.findRow(find({ wikiUrl: 'https://evil.com/wiki/test-node?sheet=sheet1' }), signal()),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('never writes', async () => {
    const { calls, service } = setup({ read: () => rows([['a', '张三']]) });
    await service.findRow(find({ range: 'A1:B1' }), signal());
    expect(calls.every((call) => call.method !== 'PUT')).toBe(true);
  });
});

describe('FeishuSheetCapabilityService.writeCells', () => {
  it('writes the matrix with exactly one PUT after reading the current content', async () => {
    const { calls, service } = setup({ read: () => rows([['旧', '旧']]) });

    const result = await service.writeCells(write(), signal());

    expect(result).toEqual({ range: 'C12:D12', updatedCells: 2, status: 'written' });
    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe('/open-apis/sheets/v2/spreadsheets/shtTOKEN/values');
    expect(puts[0].body).toEqual({
      valueRange: { range: 'sheet1!C12:D12', values: [['一', '二']] },
    });
    expect(calls.indexOf(puts[0])).toBe(calls.length - 1);
  });

  it('skips the write when the cells already contain the requested values', async () => {
    const { calls, service } = setup({ read: () => rows([['一', '二']]) });
    const result = await service.writeCells(write(), signal());
    expect(result).toEqual({ range: 'C12:D12', updatedCells: 0, status: 'skipped' });
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('writes formula-like strings as literal text and null as an empty cell', async () => {
    const { calls, service } = setup({ read: () => rows([]) });
    await service.writeCells(
      write({
        range: 'A1:C3',
        values: [
          ['=HYPERLINK("http://evil")', '@SUM(A1)', '-1+1'],
          ['+cmd', 5, true],
          [null, -3, '普通'],
        ],
      }),
      signal(),
    );
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body.valueRange.values).toEqual([
      ['\'=HYPERLINK("http://evil")', "'@SUM(A1)", "'-1+1"],
      ["'+cmd", 5, true],
      ['', -3, '普通'],
    ]);
  });

  it('always reports the matrix cell count regardless of what Feishu returns', async () => {
    for (const data of [{}, { updatedCells: 99 }, { updatedCells: 0 }]) {
      const { service } = setup({
        write: () => ({ status: 200, headers: {}, body: JSON.stringify({ code: 0, data }) }),
      });
      const result = await service.writeCells(
        write({
          range: 'A1:B2',
          values: [
            ['a', 'b'],
            ['c', 'd'],
          ],
        }),
        signal(),
      );
      expect(result).toEqual({ range: 'A1:B2', updatedCells: 4, status: 'written' });
    }
  });

  it('rejects matrices that do not match the range before any network access', async () => {
    const { service, request } = setup();
    for (const overrides of [
      write({ values: [['only one']] }),
      write({
        values: [
          ['a', 'b'],
          ['c', 'd'],
        ],
      }),
      write({ values: [['a', 'b', 'c']] }),
      write({ range: 'A1:A201', values: [['a']] }),
      write({ range: 'A1:AZ1', values: [['a']] }),
    ]) {
      const error = await failure(service.writeCells(overrides, signal()));
      expect([400, 422]).toContain(error.getStatus());
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('never retries a failed write and does not expose upstream text', async () => {
    const { calls, service } = setup({
      read: () => rows([]),
      write: () => httpError(500, { code: 99999, msg: `boom ${APP_SECRET}`, values: ['一'] }),
    });
    const error = await failure(service.writeCells(write(), signal()));
    expect(error.getStatus()).toBe(502);
    expect(error.message).toContain('写入表格范围');
    expect(error.message).toContain('HTTP 500');
    expect(error.message).not.toContain(APP_SECRET);
    expect(error.message).not.toContain('boom');
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('does not send the write when the caller cancels before it', async () => {
    const controller = new AbortController();
    const { calls, service } = setup({
      read: () => {
        controller.abort();
        return rows([]);
      },
    });
    const error = await failure(service.writeCells(write(), controller.signal));
    expect(error.getStatus()).toBe(499);
    expect(error.message).toContain('未发送写入');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it.each([499, 504])(
    'warns that the write may have been applied when interrupted (%i)',
    async (status) => {
      const gateway = new FeishuSheetGatewayService({
        request: vi.fn(async (options: any) => {
          if (options.method === 'PUT') throw new WorkflowCapabilityException('x', status);
          const path = options.url.pathname as string;
          const body = path.includes('/auth/')
            ? { code: 0, tenant_access_token: 't' }
            : path.includes('/wiki/')
              ? { code: 0, data: { node: { obj_type: 'sheet', obj_token: 'shtTOKEN' } } }
              : { code: 0, data: { valueRange: { values: [] } } };
          return { status: 200, headers: {}, body: JSON.stringify(body) };
        }),
      } as unknown as ExternalHttpClientService);
      const error = await failure(
        new FeishuSheetCapabilityService(gateway).writeCells(write(), signal()),
      );
      expect(error.getStatus()).toBe(status);
      expect(error.message).toContain('可能已写入');
    },
  );
});
