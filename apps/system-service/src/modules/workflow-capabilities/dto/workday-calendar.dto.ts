import { Transform } from 'class-transformer';
import { Equals, IsDateString } from 'class-validator';
import {
  WORKDAY_CALENDAR_DATE_PATTERN,
  WORKDAY_CALENDAR_REGION,
} from '../../../constants/workday-calendar.constants';
import { RawText, rawValue } from './workflow-capability-dto.util';

/** 区域与起止日期都由调用方显式提供，不设隐式默认；真实日期与跨度由 Service 再次校验。 */
export class WorkdayCalendarDto {
  @Transform(rawValue)
  @Equals(WORKDAY_CALENDAR_REGION)
  region!: typeof WORKDAY_CALENDAR_REGION;

  @RawText({ min: 10, max: 10, pattern: WORKDAY_CALENDAR_DATE_PATTERN })
  @IsDateString({ strict: true })
  startDate!: string;

  @RawText({ min: 10, max: 10, pattern: WORKDAY_CALENDAR_DATE_PATTERN })
  @IsDateString({ strict: true })
  endDate!: string;
}
