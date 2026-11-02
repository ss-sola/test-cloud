import type {
  WORKDAY_CALENDAR_REASONS,
  WORKDAY_CALENDAR_REGION,
  WORKDAY_CALENDAR_TIME_ZONE,
} from '../../constants/workday-calendar.constants';

export type WorkdayCalendarReason =
  (typeof WORKDAY_CALENDAR_REASONS)[keyof typeof WORKDAY_CALENDAR_REASONS];

/** 年度数据中的单条覆盖：isOffDay 为 true 表示放假，false 表示补班。 */
export interface WorkdayCalendarOverride {
  date: string;
  name: string;
  isOffDay: boolean;
}

/** 数据来源元数据：papers 仅展示政府通知链接，不会被抓取。 */
export interface WorkdayCalendarSource {
  year: number;
  url: string;
  papers: string[];
}

/** 经过校验并按白名单重建的年度数据。 */
export interface WorkdayCalendarYear extends WorkdayCalendarSource {
  days: WorkdayCalendarOverride[];
}

export interface WorkdayCalendarDay {
  date: string;
  isWorkday: boolean;
  reason: WorkdayCalendarReason;
  /** 仅放假或补班日有名称，普通日期为空字符串。 */
  name: string;
}

export interface WorkdayCalendarResult {
  region: typeof WORKDAY_CALENDAR_REGION;
  timeZone: typeof WORKDAY_CALENDAR_TIME_ZONE;
  startDate: string;
  endDate: string;
  workdays: string[];
  days: WorkdayCalendarDay[];
  sources: WorkdayCalendarSource[];
}
