import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { WeeklyReportPeriod } from '../weekly-report.types';
import { WeeklyReportPublishDto } from './weekly-report-publish.dto';

export class WeeklyReportProjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  repo!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  person!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  branch?: string;
}

export class GenerateWeeklyCommitReportDto {
  @IsIn(['last-week', 'this-week'])
  period!: WeeklyReportPeriod;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => WeeklyReportProjectDto)
  configs?: WeeklyReportProjectDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => WeeklyReportPublishDto)
  publish?: WeeklyReportPublishDto;
}
