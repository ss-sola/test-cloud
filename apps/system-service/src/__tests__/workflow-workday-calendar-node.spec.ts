import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKDAY_CALENDAR_DAY_MS,
  WORKDAY_CALENDAR_SOURCE_BASE_URL,
} from '../constants/workday-calendar.constants';
import type { WorkdayCalendarResult } from '../modules/workflow-capabilities/workday-calendar.types';

const load = createRequire(__filename);
const Core = load(resolve(__dirname, '../../public/js/workflow-core.js'));
const Data = load(resolve(__dirname, '../../public/js/workflow-data.js'));
const Nodes = load(resolve(__dirname, '../../public/js/workflow-nodes.js'));
const View = load(resolve(__dirname, '../../public/js/workflow-capability-view.js'));
const registry = Nodes.createRegistry();
const current = registry.get('date-range', 2);
const legacy = registry.get('date-range', 1);
const PAPER = 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm';
const CONFIG = {
  period: 'custom',
  since: '2026-01-01',
  until: '2026-01-04',
  includeWorkdays: true,
};
const rangeOf = (config = CONFIG, timeZone = 'Asia/Shanghai') =>
  Data.createDateRange(config, new Date('2026-01-01T00:00:00Z'), timeZone);

/** 受控元旦日历：三天休假，周日调休上班；不依赖真实网络或模型。 */
function calendarFixture(): WorkdayCalendarResult {
  return {
    region: 'CN',
    timeZone: 'Asia/Shanghai',
    startDate: '2026-01-01',
    endDate: '2026-01-04',
    days: [
      { date: '2026-01-01', isWorkday: false, reason: 'holiday', name: '元旦' },
      { date: '2026-01-02', isWorkday: false, reason: 'holiday', name: '元旦' },
      { date: '2026-01-03', isWorkday: false, reason: 'holiday', name: '元旦' },
      { date: '2026-01-04', isWorkday: true, reason: 'makeup-workday', name: '元旦' },
    ],
    workdays: ['2026-01-04'],
    sources: [{ year: 2026, url: `${WORKDAY_CALENDAR_SOURCE_BASE_URL}2026.json`, papers: [PAPER] }],
  };
}

/** 补齐受控年度的普通日期，验证非上海时区不改写原范围。 */
function ordinaryCalendar(startDate: string, endDate: string): WorkdayCalendarResult {
  const days: WorkdayCalendarResult['days'] = [];
  for (
    let time = Date.parse(`${startDate}T00:00:00Z`);
    time <= Date.parse(`${endDate}T00:00:00Z`);
    time += WORKDAY_CALENDAR_DAY_MS
  ) {
    const date = new Date(time);
    const weekend = [0, 6].includes(date.getUTCDay());
    days.push({
      date: date.toISOString().slice(0, 10),
      isWorkday: !weekend,
      reason: weekend ? 'weekend' : 'weekday',
      name: '',
    });
  }
  return {
    region: 'CN',
    timeZone: 'Asia/Shanghai',
    startDate,
    endDate,
    days,
    workdays: days.filter((day) => day.isWorkday).map((day) => day.date),
    sources: [{ year: 2026, url: `${WORKDAY_CALENDAR_SOURCE_BASE_URL}2026.json`, papers: [PAPER] }],
  };
}

/** 原日期节点挂载到最小 DOM，使用真实 change 事件验证现有 checkbox 保存和运行锁。 */
function mountDateForm() {
  const elements: Array<ReturnType<typeof element>> = [];
  function element() {
    return Object.assign(new EventTarget(), {
      dataset: {} as Record<string, string>,
      value: '',
      checked: false,
      disabled: false,
      classList: { add: vi.fn(), toggle: vi.fn() },
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      append: vi.fn(),
      replaceChildren: vi.fn(),
      textContent: '',
    });
  }
  const create = () => {
    const node = element();
    elements.push(node);
    return node;
  };
  vi.stubGlobal('document', { createElement: create, createElementNS: create });
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const node = {
    id: 'date',
    type: 'date-range',
    version: 2,
    name: '日期范围',
    config: { ...CONFIG, includeWorkdays: false },
  };
  const updateNode = vi.fn((_id: string, patch: { config: object }) => {
    const error = current.validateConfig(patch.config);
    if (error) throw new Error(error);
  });
  const renderer = View.capability({
    node,
    body: create(),
    workspace: { registry, updateNode },
    documentId: 'form',
  });
  return { elements, node, renderer, updateNode };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('date-range 工作日开关与版本兼容', () => {
  it('不增加节点类型或端口，默认关闭且不声明凭据引用', () => {
    expect(registry.list()).toHaveLength(17);
    expect(
      registry.list().filter((item: { type: string }) => item.type === 'date-range'),
    ).toHaveLength(1);
    expect(current.execution).toBe(Core.NODE_EXECUTION.data);
    expect(current.inputs).toEqual([]);
    expect(current.outputs).toEqual(legacy.outputs);
    expect(current.defaults.includeWorkdays).toBe(false);
    expect(current.credentialGroup).toBeUndefined();
    expect(current.validateConfig(current.defaults)).toBeNull();
    expect(
      current.validateConfig({ ...current.defaults, credentialRef: 'token-config' }),
    ).not.toBeNull();
  });

  it.each(['true', 'false', 0, 1, null, undefined])('v2 拒绝非布尔开关 %j', (includeWorkdays) => {
    expect(current.validateConfig({ ...current.defaults, includeWorkdays })).not.toBeNull();
  });

  it('v1 保持本地行为，且只在显式升级时补 false，升级可撤销', async () => {
    expect(legacy.validateConfig({ ...legacy.defaults, includeWorkdays: false })).not.toBeNull();
    const services = { workdayCalendar: vi.fn() };
    expect(legacy.execute({ node: { config: legacy.defaults }, services })).toHaveProperty('range');
    expect(services.workdayCalendar).not.toHaveBeenCalled();
    const workspace = new Core.Workspace({ registry });
    workspace.addNode('date-range', { x: 0, y: 0 });
    const doc = JSON.parse(workspace.exportDocument());
    doc.nodes[0].version = 1;
    doc.nodes[0].config = { period: 'custom', since: '2026-01-01', until: '2026-01-04' };
    workspace.importDocument(doc);
    const before = workspace.exportDocument();
    const id = workspace.getDocument().nodes[0].id;
    expect(workspace.getDocument().nodes[0].config).not.toHaveProperty('includeWorkdays');
    workspace.upgradeNode(id);
    expect(workspace.getDocument().nodes[0]).toMatchObject({
      version: 2,
      config: { ...doc.nodes[0].config, includeWorkdays: false },
    });
    workspace.undo();
    expect(workspace.exportDocument()).toBe(before);
  });

  it('关闭开关时只计算日期，不访问日历或凭据', async () => {
    const workdayCalendar = vi.fn();
    const range = rangeOf();
    const dateRange = vi.fn(() => range);
    const value = await current.execute({
      node: { config: { ...CONFIG, includeWorkdays: false } },
      services: { dateRange, workdayCalendar },
    });
    expect(value).toEqual({ range });
    expect(value.range).toBe(range);
    expect(dateRange).toHaveBeenCalledOnce();
    expect(workdayCalendar).not.toHaveBeenCalled();
  });

  it('原日期表单直接提供可保存的复选开关，运行时锁定且不显示 Token 提示', () => {
    const { elements, node, renderer, updateNode } = mountDateForm();
    const checkbox = elements.find((item) => item.dataset.wfField === 'includeWorkdays')!;
    expect(checkbox).toBeDefined();
    expect(checkbox.checked).toBe(false);
    expect(elements.some((item) => item.dataset.wfNotice === 'credentials')).toBe(false);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(updateNode).toHaveBeenCalledWith(
      'date',
      { config: { ...CONFIG, includeWorkdays: true } },
      'form',
    );
    renderer.update({
      node: { ...node, config: { ...CONFIG, includeWorkdays: true } },
      state: { status: 'running', outputs: null },
      locked: true,
    });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    renderer.destroy();
  });
});

describe('无凭据联网日历适配', () => {
  it('只向固定接口提交地区和日期，并附加经过白名单重建的日历', async () => {
    const readCredentials = vi.fn(() => {
      throw new Error('不应读取 Token');
    });
    const request = vi.fn(async (_url: string, _options: RequestInit) => ({
      ok: true,
      json: async () => ({ code: 200, data: { ...calendarFixture(), apiKey: 'discarded' } }),
    }));
    const services = Nodes.createServices({ request, readCredentials });
    const range = rangeOf();
    services.dateRange = () => range;
    const controller = new AbortController();
    const result = await current.execute({
      node: { config: CONFIG },
      services,
      signal: controller.signal,
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('/api/workflow-capabilities/workday-calendar');
    expect(JSON.parse(String(options.body))).toEqual({
      region: 'CN',
      startDate: '2026-01-01',
      endDate: '2026-01-04',
    });
    expect(options).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(result.range).toEqual({ ...range, workdayCalendar: calendarFixture() });
    expect(result.range.workdayCalendar).not.toHaveProperty('apiKey');
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it('非上海时区的日期范围及其原始 since/until 保持不变', async () => {
    const config = { ...CONFIG, since: '2026-03-07', until: '2026-03-09' };
    const range = rangeOf(config, 'America/New_York');
    const calendar = ordinaryCalendar(range.startDate, range.endDate);
    const invoke = vi.fn(async () => ({ code: 200, data: calendar }));
    const services = Nodes.createServices({ invoke });
    services.dateRange = () => range;
    const result = await current.execute({ node: { config }, services });
    expect(result.range.since).toBe('2026-03-07T05:00:00.000Z');
    expect(result.range.until).toBe('2026-03-10T03:59:59.999Z');
    expect(result.range.workdayCalendar.startDate).toBe(range.startDate);
    expect(result.range.workdayCalendar.endDate).toBe(range.endDate);
    expect(invoke.mock.calls).toHaveLength(1);
  });

  it.each([
    { ...calendarFixture(), workdays: [] },
    { ...calendarFixture(), days: calendarFixture().days.slice(1) },
    { ...calendarFixture(), region: 'US' },
    { ...calendarFixture(), startDate: '2026-01-02' },
    { ...calendarFixture(), workdays: ['2026-01-04', '2026-01-04'] },
    { ...calendarFixture(), sources: [] },
    {
      ...calendarFixture(),
      sources: [{ year: 2026, url: 'https://evil.example/data.json', papers: [PAPER] }],
    },
    {
      ...calendarFixture(),
      sources: [
        {
          year: 2026,
          url: `${WORKDAY_CALENDAR_SOURCE_BASE_URL}2026.json`,
          papers: ['https://www.gov.cn.evil.example/notice'],
        },
      ],
    },
    {
      ...calendarFixture(),
      days: [
        ...calendarFixture().days.slice(0, 3),
        { date: '2026-01-04', isWorkday: true, reason: 'weekday', name: '' },
      ],
    },
  ])('拒绝不完整、不一致或不受信任的响应', async (data) => {
    const services = Nodes.createServices({ invoke: async () => ({ code: 200, data }) });
    await expect(services.workdayCalendar({ range: rangeOf() })).rejects.toThrow('无效或不完整');
  });

  it('日历缺失失败时不返回仅含日期的成功结果', async () => {
    const services = Nodes.createServices({
      invoke: async () => ({ code: 503, message: '年度尚未发布。' }),
    });
    services.dateRange = () => rangeOf();
    await expect(current.execute({ node: { config: CONFIG }, services })).rejects.toThrow(
      '年度尚未发布',
    );
  });

  it('取消后立即结束等待，忽略迟到日历且不读取凭据', async () => {
    let complete!: (value: unknown) => void;
    const reply = new Promise((done) => {
      complete = done;
    });
    const readCredentials = vi.fn();
    const invoke = vi.fn(() => reply);
    const services = Nodes.createServices({ invoke, readCredentials });
    const controller = new AbortController();
    const pending = services
      .workdayCalendar({ range: rangeOf(), signal: controller.signal })
      .catch((error: unknown) => error);
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(invoke).toHaveBeenCalledOnce();
    controller.abort();
    expect(await pending).toMatchObject({ message: expect.stringContaining('停止') });
    complete({ code: 200, data: calendarFixture() });
    await Promise.resolve();
    expect(readCredentials).not.toHaveBeenCalled();
  });
});
