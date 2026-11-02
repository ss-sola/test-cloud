import { Injectable } from '@nestjs/common';
import {
  parseCivilDay,
  WorkdayCalendarClientService,
} from '../../client/calendar/workday-calendar-client.service';
import {
  WORKDAY_CALENDAR_DAY_MS,
  WORKDAY_CALENDAR_LIMITS,
  WORKDAY_CALENDAR_MESSAGES,
  WORKDAY_CALENDAR_REASONS,
  WORKDAY_CALENDAR_REGION,
  WORKDAY_CALENDAR_TIME_ZONE,
} from '../../constants/workday-calendar.constants';
import type { WorkdayCalendarDto } from './dto/workday-calendar.dto';
import { WorkflowCapabilityException } from './workflow-capability.exception';
import type {
  WorkdayCalendarDay,
  WorkdayCalendarOverride,
  WorkdayCalendarResult,
  WorkdayCalendarSource,
} from './workday-calendar.types';

/** getUTCDay 的周日与周六。 */
const WEEKEND_DAYS = [0, 6];

/** 中国大陆工作日日历能力：编排年度数据读取，按放假/补班覆盖与星期规则计算每日结果。 */
@Injectable()
export class WorkdayCalendarCapabilityService {
  constructor(private readonly client: WorkdayCalendarClientService) {}

  /**
   * 校验区域与日期范围后串行读取所需年度文件并计算每日工作日状态；
   * 任一年度失败整体失败，不返回部分结果、不重试、不回退星期规则。
   */
  async query(input: WorkdayCalendarDto, signal: AbortSignal): Promise<WorkdayCalendarResult> {
    const limits = WORKDAY_CALENDAR_LIMITS;
    const region: unknown = input.region;
    if (region !== WORKDAY_CALENDAR_REGION) {
      throw new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.invalidRegion, 400);
    }
    const startDay = parseCivilDay(input.startDate);
    const endDay = parseCivilDay(input.endDate);
    if (startDay === null || endDay === null) {
      throw new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.invalidDate, 400);
    }
    if (endDay < startDay) {
      throw new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.invalidRange, 400);
    }
    if (endDay - startDay + 1 > limits.maxRangeDays) {
      throw new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.rangeTooLarge, 422);
    }
    const years = this.requiredYears(startDay, endDay);

    const total = AbortSignal.any([signal, AbortSignal.timeout(limits.totalTimeoutMs)]);
    const overrides = new Map<string, WorkdayCalendarOverride>();
    const sources: WorkdayCalendarSource[] = [];
    for (const year of years) {
      this.assertActive(total);
      const data = await this.client.loadYear(year, total); // 串行读取，后年度覆盖先年度
      this.assertActive(total);
      for (const item of data.days) overrides.set(item.date, item);
      sources.push({ year: data.year, url: data.url, papers: [...data.papers] });
    }

    const days: WorkdayCalendarDay[] = [];
    for (let day = startDay; day <= endDay; day += 1) {
      days.push(this.resolveDay(day, overrides));
    }
    return {
      region: WORKDAY_CALENDAR_REGION,
      timeZone: WORKDAY_CALENDAR_TIME_ZONE,
      startDate: input.startDate,
      endDate: input.endDate,
      workdays: days.filter((item) => item.isWorkday).map((item) => item.date),
      days,
      sources,
    };
  }

  /** 在年度边界拒绝取消或超时后的迟到结果，不继续读取下一年度。 */
  private assertActive(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
      ? new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.timeout, 504)
      : new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.cancelled, 499);
  }

  /** 起止年份；仅当结束日期在 12 月时追加下一年度，以覆盖其对 12 月的调休安排。 */
  private requiredYears(startDay: number, endDay: number): number[] {
    const limits = WORKDAY_CALENDAR_LIMITS;
    const start = new Date(startDay * WORKDAY_CALENDAR_DAY_MS);
    const end = new Date(endDay * WORKDAY_CALENDAR_DAY_MS);
    const years: number[] = [];
    for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year += 1) {
      years.push(year);
    }
    if (end.getUTCMonth() === 11) years.push(end.getUTCFullYear() + 1);

    if (years.some((year) => year < limits.minYear || year > limits.maxYear)) {
      throw new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.yearUnsupported, 422);
    }
    if (years.length > limits.maxYears) {
      throw new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.tooManyYears, 422);
    }
    return years;
  }

  /** 覆盖项优先（放假/补班），否则按 UTC 民用日期的星期判断周末。 */
  private resolveDay(
    day: number,
    overrides: Map<string, WorkdayCalendarOverride>,
  ): WorkdayCalendarDay {
    const instant = new Date(day * WORKDAY_CALENDAR_DAY_MS);
    const date = instant.toISOString().slice(0, 10);
    const override = overrides.get(date);
    if (override) {
      return {
        date,
        isWorkday: !override.isOffDay,
        reason: override.isOffDay
          ? WORKDAY_CALENDAR_REASONS.holiday
          : WORKDAY_CALENDAR_REASONS.makeupWorkday,
        name: override.name,
      };
    }
    const weekend = WEEKEND_DAYS.includes(instant.getUTCDay());
    return {
      date,
      isWorkday: !weekend,
      reason: weekend ? WORKDAY_CALENDAR_REASONS.weekend : WORKDAY_CALENDAR_REASONS.weekday,
      name: '',
    };
  }
}
