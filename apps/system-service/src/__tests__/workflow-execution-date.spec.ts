import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const load = createRequire(__filename);
const data = load(resolve(__dirname, '../../public/js/workflow-data.js')) as {
  createDateRange(
    config: { period: string; since?: string; until?: string },
    now?: Date,
    timeZone?: string,
  ): {
    since: string;
    until: string;
    startDate: string;
    endDate: string;
    start: { year: number; month: number; day: number };
    end: { year: number; month: number; day: number };
  };
};

describe('后端工作流显式日期上下文', () => {
  it('同一瞬间在亚洲已经周一、在美洲仍为周日，不依赖宿主时区', () => {
    const now = new Date('2026-10-18T16:30:00.000Z');
    const tokyo = data.createDateRange({ period: 'this-week' }, now, 'Asia/Tokyo');
    const losAngeles = data.createDateRange({ period: 'this-week' }, now, 'America/Los_Angeles');
    expect(tokyo).toMatchObject({
      since: '2026-10-18T15:00:00.000Z',
      until: '2026-10-25T14:59:59.999Z',
      startDate: '2026-10-19',
      endDate: '2026-10-25',
      start: { year: 2026, month: 10, day: 19 },
    });
    expect(losAngeles).toMatchObject({
      since: '2026-10-12T07:00:00.000Z',
      until: '2026-10-19T06:59:59.999Z',
      startDate: '2026-10-12',
      endDate: '2026-10-18',
    });
  });

  it('夏令时开始的一周只有167小时，结束的一周有169小时', () => {
    const spring = data.createDateRange(
      { period: 'this-week' },
      new Date('2026-03-05T12:00:00Z'),
      'America/New_York',
    );
    const fall = data.createDateRange(
      { period: 'this-week' },
      new Date('2026-10-29T12:00:00Z'),
      'America/New_York',
    );
    expect(spring).toMatchObject({
      since: '2026-03-02T05:00:00.000Z',
      until: '2026-03-09T03:59:59.999Z',
    });
    expect(fall).toMatchObject({
      since: '2026-10-26T04:00:00.000Z',
      until: '2026-11-02T04:59:59.999Z',
    });
    expect(Date.parse(spring.until) - Date.parse(spring.since) + 1).toBe(167 * 60 * 60 * 1000);
    expect(Date.parse(fall.until) - Date.parse(fall.since) + 1).toBe(169 * 60 * 60 * 1000);
  });

  it('纯日期按指定时区解释并包含直到当日结束，跨夏令时不按固定24小时叠加', () => {
    const range = data.createDateRange(
      { period: 'custom', since: '2026-03-08', until: '2026-03-08' },
      new Date('2026-01-01T00:00:00Z'),
      'America/New_York',
    );
    expect(range).toMatchObject({
      since: '2026-03-08T05:00:00.000Z',
      until: '2026-03-09T03:59:59.999Z',
      startDate: '2026-03-08',
      endDate: '2026-03-08',
    });
  });

  it('已有ISO输入不改变瞬间，模板日期标签仍按本次时区生成', () => {
    const range = data.createDateRange(
      { period: 'custom', since: '2026-10-18T16:00:00Z', until: '2026-10-19T00:00:00Z' },
      new Date('2026-01-01T00:00:00Z'),
      'Asia/Shanghai',
    );
    expect(range).toMatchObject({
      since: '2026-10-18T16:00:00.000Z',
      until: '2026-10-19T00:00:00.000Z',
      startDate: '2026-10-19',
      endDate: '2026-10-19',
    });
  });

  it('上周使用本次冻结参考时间，不在执行期间跨周漂移', () => {
    const range = data.createDateRange(
      { period: 'last-week' },
      new Date('2026-01-04T16:00:00Z'),
      'Asia/Shanghai',
    );
    expect(range).toMatchObject({
      startDate: '2025-12-29',
      endDate: '2026-01-04',
      since: '2025-12-28T16:00:00.000Z',
      until: '2026-01-04T15:59:59.999Z',
    });
  });

  it('时区日界发生夏令时跳跃时取当日最早有效瞬间', () => {
    const range = data.createDateRange(
      { period: 'custom', since: '2018-11-04', until: '2018-11-04' },
      new Date('2018-11-01T00:00:00Z'),
      'America/Sao_Paulo',
    );
    expect(range).toMatchObject({
      since: '2018-11-04T03:00:00.000Z',
      until: '2018-11-05T01:59:59.999Z',
      startDate: '2018-11-04',
      endDate: '2018-11-04',
    });
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-01'])('拒绝不存在的日历日期 %s', (since) => {
    expect(() =>
      data.createDateRange(
        { period: 'custom', since, until: '2026-12-31' },
        new Date(),
        'Asia/Shanghai',
      ),
    ).toThrow('日期不存在');
  });

  it('拒绝无效时区与参考时间，不静默回退服务器时区', () => {
    expect(() => data.createDateRange({ period: 'this-week' }, new Date(), 'Unknown/Zone')).toThrow(
      RangeError,
    );
    expect(() =>
      data.createDateRange({ period: 'this-week' }, new Date('invalid'), 'Asia/Shanghai'),
    ).toThrow('参考时间');
  });
});
