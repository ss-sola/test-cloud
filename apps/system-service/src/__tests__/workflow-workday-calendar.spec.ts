import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkdayCalendarClientService } from '../client/calendar/workday-calendar-client.service';
import type {
  ExternalHttpClientService,
  ExternalHttpRequest,
} from '../client/external/external-http-client.service';
import {
  WORKDAY_CALENDAR_LIMITS,
  WORKDAY_CALENDAR_SOURCE_BASE_URL,
} from '../constants/workday-calendar.constants';
import { WorkdayCalendarDto } from '../modules/workflow-capabilities/dto/workday-calendar.dto';
import { parseCapabilityDto } from '../modules/workflow-capabilities/dto/workflow-capability-dto.util';
import { WorkdayCalendarCapabilityService } from '../modules/workflow-capabilities/workday-calendar-capability.service';
import { WorkflowCapabilityException } from '../modules/workflow-capabilities/workflow-capability.exception';

const LEAK = 'LEAK_MARKER_5f2c';
const PAPER = 'https://www.gov.cn/zhengce/content/example.htm';

interface RawOverride {
  [extra: string]: unknown;
  date: unknown;
  name: unknown;
  isOffDay: unknown;
}

type Route = string | Error | ((request: ExternalHttpRequest) => Promise<unknown> | unknown);

/** 构造年度文件；真实 2026 事实仅取已确认的元旦与国庆安排，不代表完整年度数据。 */
function yearFile(year: number, days: RawOverride[], extra: Record<string, unknown> = {}) {
  return {
    $schema: 'https://example.invalid/schema.json',
    year,
    papers: [PAPER],
    days,
    ...extra,
  };
}

const off = (date: string, name: string): RawOverride => ({ date, name, isOffDay: true });
const work = (date: string, name: string): RawOverride => ({ date, name, isOffDay: false });

const DAYS_2026: RawOverride[] = [
  off('2026-01-01', '元旦'),
  off('2026-01-02', '元旦'),
  off('2026-01-03', '元旦'),
  work('2026-01-04', '元旦'),
  work('2026-09-20', '国庆节'),
  ...[1, 2, 3, 4, 5, 6, 7].map((day) => off(`2026-10-0${day}`, '国庆节')),
  work('2026-10-10', '国庆节'),
];

/** 受控传输层：按年度路径返回固定响应，不访问真实网络。 */
function setup(routes: Record<number, Route> = {}) {
  const request = vi.fn(async (options: ExternalHttpRequest) => {
    const year = Number(/(\d{4})\.json$/.exec(options.url.href)?.[1]);
    const route = routes[year];
    if (route === undefined) return { status: 404, headers: {}, body: '' };
    if (route instanceof Error) throw route;
    const value = typeof route === 'function' ? await route(options) : route;
    if (typeof value === 'object' && value !== null && 'status' in value) return value;
    return { status: 200, headers: {}, body: value as string };
  });
  const client = new WorkdayCalendarClientService({
    request,
  } as unknown as ExternalHttpClientService);
  const service = new WorkdayCalendarCapabilityService(client);
  return { request, client, service };
}

const json = (value: unknown) => JSON.stringify(value);
const signal = () => new AbortController().signal;
const query = (startDate: string, endDate: string) =>
  ({ region: 'CN', startDate, endDate }) as WorkdayCalendarDto;

async function failure(promise: Promise<unknown>): Promise<WorkflowCapabilityException> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WorkflowCapabilityException);
  return error as WorkflowCapabilityException;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkdayCalendarCapabilityService 日历计算', () => {
  it('普通周按星期规则判断，只读取一份年度文件且请求为无凭据固定 GET', async () => {
    const { service, request } = setup({ 2026: json(yearFile(2026, DAYS_2026)) });
    const controller = new AbortController();

    const result = await service.query(query('2026-06-01', '2026-06-07'), controller.signal);

    expect(result.region).toBe('CN');
    expect(result.timeZone).toBe('Asia/Shanghai');
    expect(result.workdays).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ]);
    expect(result.days.map((item) => item.reason)).toEqual([
      'weekday',
      'weekday',
      'weekday',
      'weekday',
      'weekday',
      'weekend',
      'weekend',
    ]);
    expect(result.days.every((item) => item.name === '')).toBe(true);
    expect(result.sources).toEqual([
      {
        year: 2026,
        url: `${WORKDAY_CALENDAR_SOURCE_BASE_URL}2026.json`,
        papers: [PAPER],
      },
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    const options = request.mock.calls[0][0];
    expect(options.url.href).toBe(
      'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json',
    );
    expect(options.method).toBe('GET');
    expect(options.body).toBeUndefined();
    expect(Object.keys(options.headers).map((key) => key.toLowerCase())).not.toContain(
      'authorization',
    );
    expect(options.timeoutMs).toBe(15_000);
    expect(options.maxResponseBytes).toBe(256 * 1024);
    controller.abort();
    expect(options.signal?.aborted).toBe(true); // 调用方取消会传到传输层
  });

  it('国庆放假覆盖周末，调休周六补班，周中放假日不是工作日', async () => {
    const { service, request } = setup({ 2026: json(yearFile(2026, DAYS_2026)) });

    const result = await service.query(query('2026-09-30', '2026-10-11'), signal());

    const byDate = new Map(result.days.map((item) => [item.date, item]));
    expect(byDate.get('2026-09-30')).toMatchObject({ isWorkday: true, reason: 'weekday' });
    for (let day = 1; day <= 7; day += 1) {
      expect(byDate.get(`2026-10-0${day}`)).toEqual({
        date: `2026-10-0${day}`,
        isWorkday: false,
        reason: 'holiday',
        name: '国庆节',
      });
    }
    expect(byDate.get('2026-10-08')).toMatchObject({ isWorkday: true, reason: 'weekday' });
    expect(byDate.get('2026-10-09')).toMatchObject({ isWorkday: true, reason: 'weekday' });
    expect(byDate.get('2026-10-10')).toEqual({
      date: '2026-10-10',
      isWorkday: true,
      reason: 'makeup-workday',
      name: '国庆节',
    });
    expect(byDate.get('2026-10-11')).toMatchObject({ isWorkday: false, reason: 'weekend' });
    expect(result.workdays).toEqual(['2026-09-30', '2026-10-08', '2026-10-09', '2026-10-10']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('周日补班与元旦周中放假、完整连续输出且 workdays 与 days 一致', async () => {
    const { service } = setup({ 2026: json(yearFile(2026, DAYS_2026)) });

    const result = await service.query(query('2026-01-01', '2026-01-05'), signal());

    expect(result.days.map((item) => [item.date, item.reason])).toEqual([
      ['2026-01-01', 'holiday'],
      ['2026-01-02', 'holiday'],
      ['2026-01-03', 'holiday'],
      ['2026-01-04', 'makeup-workday'],
      ['2026-01-05', 'weekday'],
    ]);
    expect(result.workdays).toEqual(['2026-01-04', '2026-01-05']);
    expect(result.workdays).toEqual(
      result.days.filter((item) => item.isWorkday).map((item) => item.date),
    );

    const sunday = await setup({ 2026: json(yearFile(2026, DAYS_2026)) }).service.query(
      query('2026-09-18', '2026-09-21'),
      signal(),
    );
    expect(sunday.days.map((item) => item.reason)).toEqual([
      'weekday',
      'weekend',
      'makeup-workday',
      'weekday',
    ]);
  });

  it('区间内没有工作日时返回空列表而不是失败', async () => {
    const { service } = setup({ 2026: json(yearFile(2026, DAYS_2026)) });

    const result = await service.query(query('2026-10-01', '2026-10-07'), signal());

    expect(result.workdays).toEqual([]);
    expect(result.days).toHaveLength(7);
  });

  it('允许单日并正确处理闰年 2 月 29 日', async () => {
    const { service } = setup({ 2028: json(yearFile(2028, [off('2028-01-01', '元旦')])) });

    const single = await service.query(query('2028-02-29', '2028-02-29'), signal());
    expect(single.days).toEqual([
      { date: '2028-02-29', isWorkday: true, reason: 'weekday', name: '' },
    ]);

    const span = await service.query(query('2028-02-28', '2028-03-01'), signal());
    expect(span.days.map((item) => item.date)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });

  it('跨年区间读取起止两年且不多读无关年份，次年同日期覆盖前一年', async () => {
    const { service, request } = setup({
      2025: json(yearFile(2025, [work('2025-12-31', '年末')])),
      2026: json(yearFile(2026, [off('2025-12-31', '年末调整'), off('2026-01-01', '元旦')])),
    });

    const result = await service.query(query('2025-12-30', '2026-01-05'), signal());

    expect(request.mock.calls.map(([options]) => options.url.pathname.split('/').pop())).toEqual([
      '2025.json',
      '2026.json',
    ]);
    expect(result.sources.map((item) => item.year)).toEqual([2025, 2026]);
    expect(result.days.find((item) => item.date === '2025-12-31')).toMatchObject({
      isWorkday: false,
      reason: 'holiday',
      name: '年末调整',
    });
  });

  it('结束于 12 月时追加下一年度，后年度对同日期的覆盖优先于先年度', async () => {
    const { service, request } = setup({
      2026: json(yearFile(2026, [work('2026-12-31', '旧安排')])),
      2027: json(yearFile(2027, [off('2026-12-31', '跨年调整'), off('2027-01-01', '元旦')])),
    });

    const result = await service.query(query('2026-12-28', '2026-12-31'), signal());

    expect(request.mock.calls.map(([options]) => options.url.pathname.split('/').pop())).toEqual([
      '2026.json',
      '2027.json',
    ]);
    expect(result.days[3]).toEqual({
      date: '2026-12-31',
      isWorkday: false,
      reason: 'holiday',
      name: '跨年调整',
    });
    expect(result.sources.map((item) => item.year)).toEqual([2026, 2027]);
  });

  it('最大跨度 366 天可跨三个年度文件，367 天被拒绝且不发请求', async () => {
    const { service, request } = setup({
      2025: json(yearFile(2025, [off('2025-12-31', 'x')])),
      2026: json(yearFile(2026, [off('2026-01-01', 'x')])),
      2027: json(yearFile(2027, [off('2027-01-01', 'x')])),
    });

    const result = await service.query(query('2025-12-31', '2026-12-31'), signal());
    expect(result.days).toHaveLength(366);
    expect(request).toHaveBeenCalledTimes(WORKDAY_CALENDAR_LIMITS.maxYears);

    request.mockClear();
    const error = await failure(service.query(query('2025-12-30', '2026-12-31'), signal()));
    expect(error.getStatus()).toBe(422);
    expect(request).not.toHaveBeenCalled();
  });

  it('返回结果只包含白名单字段，不透传上游多余字段', async () => {
    const { service } = setup({
      2026: json(yearFile(2026, [{ ...off('2026-01-01', '元旦'), secret: LEAK }], { debug: LEAK })),
    });

    const result = await service.query(query('2026-01-01', '2026-01-02'), signal());

    expect(JSON.stringify(result)).not.toContain(LEAK);
    expect(JSON.stringify(result)).not.toContain('$schema');
    expect(Object.keys(result).sort()).toEqual(
      ['days', 'endDate', 'region', 'sources', 'startDate', 'timeZone', 'workdays'].sort(),
    );
  });

  it('信任边界：结构合法但漏录覆盖项的数据无法被识别，仅按星期规则计算', async () => {
    // 文件只列了元旦、没有国庆；结构、年度、来源与日期校验全部通过，Service 无法得知漏录。
    const { service } = setup({
      2026: json(yearFile(2026, [off('2026-01-01', '元旦')])),
    });

    const result = await service.query(query('2026-10-01', '2026-10-02'), signal());

    expect(result.workdays).toEqual(['2026-10-01', '2026-10-02']);
    expect(result.days.every((item) => item.reason === 'weekday')).toBe(true);
  });
});

describe('WorkdayCalendarCapabilityService 参数校验', () => {
  it.each([
    ['区域不是 CN', { region: 'US', startDate: '2026-06-01', endDate: '2026-06-02' }, 400],
    ['区域小写', { region: 'cn', startDate: '2026-06-01', endDate: '2026-06-02' }, 400],
    ['缺少区域', { startDate: '2026-06-01', endDate: '2026-06-02' }, 400],
    ['日期不是字符串', { region: 'CN', startDate: 20260601, endDate: '2026-06-02' }, 400],
    ['日期格式错误', { region: 'CN', startDate: '2026/06/01', endDate: '2026-06-02' }, 400],
    ['不存在的 2 月 30 日', { region: 'CN', startDate: '2026-02-30', endDate: '2026-03-02' }, 400],
    ['非闰年 2 月 29 日', { region: 'CN', startDate: '2026-06-01', endDate: '2027-02-29' }, 400],
    ['月份为 13', { region: 'CN', startDate: '2026-13-01', endDate: '2026-13-02' }, 400],
    ['结束早于开始', { region: 'CN', startDate: '2026-06-02', endDate: '2026-06-01' }, 400],
    ['超过 366 天', { region: 'CN', startDate: '2026-01-01', endDate: '2027-01-02' }, 422],
    ['早于最早支持年度', { region: 'CN', startDate: '2006-12-31', endDate: '2006-12-31' }, 422],
    ['晚于最晚支持年度', { region: 'CN', startDate: '2101-01-01', endDate: '2101-01-02' }, 422],
  ])('Service 自行拒绝：%s，且不发起请求', async (_name, input, status) => {
    const { service, request } = setup({ 2026: json(yearFile(2026, DAYS_2026)) });

    const error = await failure(service.query(input as unknown as WorkdayCalendarDto, signal()));

    expect(error.getStatus()).toBe(status);
    expect(request).not.toHaveBeenCalled();
  });

  it('DTO 要求显式 region 与起止日期，不设隐式默认并拒绝未知字段', () => {
    const valid = { region: 'CN', startDate: '2026-06-01', endDate: '2026-06-07' };
    expect(parseCapabilityDto(WorkdayCalendarDto, valid)).toMatchObject(valid);

    for (const body of [
      { startDate: '2026-06-01', endDate: '2026-06-07' },
      { ...valid, region: 'cn' },
      { ...valid, region: 1 },
      { ...valid, startDate: 20260601 },
      { ...valid, endDate: '2026-6-7' },
      { ...valid, url: 'https://example.com/' },
      { ...valid, runtime: { token: LEAK } },
    ]) {
      expect(parseCapabilityDto(WorkdayCalendarDto, body)).toBeNull();
    }
  });
});

describe('WorkdayCalendarClientService 数据校验', () => {
  const invalidCases: Array<[string, unknown]> = [
    ['年度与请求不一致', yearFile(2025, DAYS_2026)],
    ['年度不是数字', yearFile(2026, DAYS_2026, { year: '2026' })],
    ['papers 缺失', yearFile(2026, DAYS_2026, { papers: undefined })],
    ['papers 为空', yearFile(2026, DAYS_2026, { papers: [] })],
    ['papers 过多', yearFile(2026, DAYS_2026, { papers: Array(25).fill(PAPER) })],
    ['papers 含非字符串', yearFile(2026, DAYS_2026, { papers: [123] })],
    ['papers 使用 http', yearFile(2026, DAYS_2026, { papers: [`http://www.gov.cn/${LEAK}`] })],
    [
      'papers 域名后缀伪造',
      yearFile(2026, DAYS_2026, { papers: [`https://www.gov.cn.evil.com/${LEAK}`] }),
    ],
    ['papers 子域名', yearFile(2026, DAYS_2026, { papers: [`https://sub.www.gov.cn/${LEAK}`] })],
    ['papers 带端口', yearFile(2026, DAYS_2026, { papers: [`https://www.gov.cn:8443/${LEAK}`] })],
    [
      'papers 带账号密码',
      yearFile(2026, DAYS_2026, { papers: [`https://u:p@www.gov.cn/${LEAK}`] }),
    ],
    [
      'papers 用 @ 伪装主机',
      yearFile(2026, DAYS_2026, { papers: [`https://www.gov.cn@evil.com/${LEAK}`] }),
    ],
    ['papers 带 fragment', yearFile(2026, DAYS_2026, { papers: [`https://www.gov.cn/a#${LEAK}`] })],
    ['papers 含空白', yearFile(2026, DAYS_2026, { papers: [`https://www.gov.cn/a b${LEAK}`] })],
    [
      'papers 其他主机',
      yearFile(2026, DAYS_2026, { papers: [`https://evil.example.com/${LEAK}`] }),
    ],
    [
      'papers 过长',
      yearFile(2026, DAYS_2026, { papers: [`https://www.gov.cn/${'a'.repeat(600)}`] }),
    ],
    ['days 缺失', yearFile(2026, DAYS_2026, { days: undefined })],
    ['days 为空', yearFile(2026, [])],
    [
      'days 过多',
      yearFile(
        2026,
        Array.from({ length: 401 }, (_, index) => off(`2026-01-01`, `x${index}`)),
      ),
    ],
    ['days 条目不是对象', yearFile(2026, [LEAK as unknown as RawOverride])],
    ['日期格式无效', yearFile(2026, [off(`2026-1-1${LEAK}`, '元旦')])],
    ['日期不存在', yearFile(2026, [off('2026-02-30', '元旦')])],
    ['日期超出相邻年度', yearFile(2026, [off('2028-01-01', '元旦')])],
    ['日期早于相邻年度', yearFile(2026, [off('2024-12-31', '元旦')])],
    ['同一文件日期重复', yearFile(2026, [off('2026-01-01', '元旦'), work('2026-01-01', '元旦')])],
    ['isOffDay 为字符串', yearFile(2026, [{ date: '2026-01-01', name: '元旦', isOffDay: 'true' }])],
    ['isOffDay 为数字', yearFile(2026, [{ date: '2026-01-01', name: '元旦', isOffDay: 1 }])],
    ['名称不是字符串', yearFile(2026, [{ date: '2026-01-01', name: 1, isOffDay: true }])],
    ['名称为空', yearFile(2026, [off('2026-01-01', '')])],
    ['名称全空白', yearFile(2026, [off('2026-01-01', '   ')])],
    ['名称过长', yearFile(2026, [off('2026-01-01', LEAK.repeat(10))])],
    ['名称含控制字符', yearFile(2026, [off('2026-01-01', `元旦\n${LEAK}`)])],
    ['根节点是数组', [LEAK]],
    ['根节点是 null', null],
    ['根节点是字符串', LEAK],
  ];

  it.each(invalidCases)('数据结构错误返回 502 且不泄露原文：%s', async (_name, payload) => {
    const { service, request } = setup({ 2026: json(payload) });

    const error = await failure(service.query(query('2026-06-01', '2026-06-07'), signal()));

    expect(error.getStatus()).toBe(502);
    expect(error.message).not.toContain(LEAK);
    expect(error.message).not.toContain('www.gov.cn');
    expect(request).toHaveBeenCalledTimes(1); // 不自动重试
  });

  it('无法解析的 JSON 返回 502 且不泄露正文', async () => {
    const { service } = setup({ 2026: `{"year": 2026, ${LEAK}` });

    const error = await failure(service.query(query('2026-06-01', '2026-06-07'), signal()));

    expect(error.getStatus()).toBe(502);
    expect(error.message).not.toContain(LEAK);
  });

  it('未发布或缺少年度（404）返回 503，不回退星期规则也不返回部分结果', async () => {
    const { service, request } = setup({ 2026: json(yearFile(2026, DAYS_2026)) });

    const error = await failure(service.query(query('2026-12-28', '2026-12-31'), signal()));

    expect(error.getStatus()).toBe(503); // 2027 年度缺失
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('上游非 200 与网络异常统一返回受控 502，且不泄露原始错误', async () => {
    const serverError = setup({ 2026: { status: 500, headers: {}, body: LEAK } as never });
    const error = await failure(
      serverError.service.query(query('2026-06-01', '2026-06-07'), signal()),
    );
    expect(error.getStatus()).toBe(502);
    expect(error.message).not.toContain(LEAK);

    const partial = setup({ 2026: { status: 206, headers: {}, body: LEAK } as never });
    expect(
      (
        await failure(partial.service.query(query('2026-06-01', '2026-06-07'), signal()))
      ).getStatus(),
    ).toBe(502);

    const network = setup({ 2026: new Error(`connect ECONNRESET ${LEAK}`) });
    const networkError = await failure(
      network.service.query(query('2026-06-01', '2026-06-07'), signal()),
    );
    expect(networkError.getStatus()).toBe(502);
    expect(networkError.message).not.toContain(LEAK);
    expect(network.request).toHaveBeenCalledTimes(1);
  });

  it('传输层受控异常（超时、超限、重定向）原样传出，不重试', async () => {
    const timeout = new WorkflowCapabilityException('外部服务请求超时。', 504);
    const { service, request } = setup({ 2026: timeout });

    const error = await failure(service.query(query('2026-06-01', '2026-06-07'), signal()));

    expect(error).toBe(timeout);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('loadYear 直接返回规范化年度结构并按日期排序', async () => {
    const { client } = setup({
      2026: json(yearFile(2026, [off('2026-10-02', '国庆节'), off('2026-01-01', '元旦')])),
    });

    await expect(client.loadYear(2026, signal())).resolves.toEqual({
      year: 2026,
      url: `${WORKDAY_CALENDAR_SOURCE_BASE_URL}2026.json`,
      papers: [PAPER],
      days: [
        { date: '2026-01-01', name: '元旦', isOffDay: true },
        { date: '2026-10-02', name: '国庆节', isOffDay: true },
      ],
    });
  });

  it('loadYear 拒绝不支持的年度，防止构造任意路径', async () => {
    const { client, request } = setup();

    for (const year of [2026.5, Number.NaN, 2006, 2101, '2026/../x' as unknown as number]) {
      const error = await failure(client.loadYear(year, signal()));
      expect(error.getStatus()).toBe(422);
    }
    expect(request).not.toHaveBeenCalled();
  });
});

describe('WorkdayCalendarCapabilityService 取消与超时', () => {
  it('请求开始前已取消则不发请求', async () => {
    const { service, request } = setup({ 2026: json(yearFile(2026, DAYS_2026)) });
    const controller = new AbortController();
    controller.abort();

    const error = await failure(
      service.query(query('2026-06-01', '2026-06-07'), controller.signal),
    );

    expect(error.getStatus()).toBe(499);
    expect(request).not.toHaveBeenCalled();
  });

  it('响应返回后发现已取消则不处理结果也不启动下一年度', async () => {
    const controller = new AbortController();
    const { service, request } = setup({
      2026: () => {
        controller.abort();
        return json(yearFile(2026, DAYS_2026));
      },
      2027: json(yearFile(2027, [off('2027-01-01', '元旦')])),
    });

    const error = await failure(
      service.query(query('2026-12-28', '2026-12-31'), controller.signal),
    );

    expect(error.getStatus()).toBe(499);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('总时限使用 45 秒预算，到期后以 504 终止且不再读取后续年度', async () => {
    const clock = new AbortController(); // 受控时钟：手动触发总时限到期
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(clock.signal);
    const { service, request } = setup({
      2026: () => {
        clock.abort(new DOMException('timeout', 'TimeoutError'));
        return json(yearFile(2026, DAYS_2026));
      },
      2027: json(yearFile(2027, [off('2027-01-01', '元旦')])),
    });

    const error = await failure(service.query(query('2026-12-28', '2026-12-31'), signal()));

    expect(timeoutSpy).toHaveBeenCalledWith(WORKDAY_CALENDAR_LIMITS.totalTimeoutMs);
    expect(WORKDAY_CALENDAR_LIMITS.totalTimeoutMs).toBe(45_000);
    expect(error.getStatus()).toBe(504);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
