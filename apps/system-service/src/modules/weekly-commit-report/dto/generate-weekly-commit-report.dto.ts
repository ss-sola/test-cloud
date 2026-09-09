import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
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

class WeeklyReportAiDto {
  @IsString()
  @MaxLength(2048)
  baseUrl!: string;

  @IsString()
  @MaxLength(4096)
  apiKey!: string;

  @IsString()
  @MaxLength(256)
  model!: string;
}

class WeeklyReportLimitsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(300000)
  commandTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(120000)
  aiTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(10)
  maxProjects?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(500)
  maxCommitsPerRepository?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  maxPromptCommits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1000)
  @Max(100000)
  maxPromptCharacters?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1000)
  @Max(500000)
  maxOutputCharacters?: number;
}

class WeeklyReportRuntimeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  githubToken!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  allowedRepositories?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => WeeklyReportAiDto)
  ai?: WeeklyReportAiDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WeeklyReportLimitsDto)
  limits?: WeeklyReportLimitsDto;
}

export class GenerateWeeklyCommitReportDto {
  @IsIn(['last-week', 'this-week'])
  period!: WeeklyReportPeriod;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => WeeklyReportProjectDto)
  configs!: WeeklyReportProjectDto[];

  @ValidateNested()
  @Type(() => WeeklyReportRuntimeDto)
  runtime!: WeeklyReportRuntimeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WeeklyReportPublishDto)
  publish?: WeeklyReportPublishDto;
}
