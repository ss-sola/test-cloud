import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class WeeklyReportPublishTargetDto {
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  wikiUrl!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  sheetId!: string;

  @IsString()
  @Matches(/^A\d+:B\d+$/i)
  @MaxLength(32)
  lookupRange!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;
}

export class WeeklyReportPublishSettingsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  appId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  appSecret!: string;

  @IsInt()
  @Min(1000)
  @Max(300000)
  requestTimeoutMs!: number;

  @IsInt()
  @Min(0)
  @Max(10)
  maxRetries!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => WeeklyReportPublishTargetDto)
  monthlyTargets!: WeeklyReportPublishTargetDto[];
}

export class WeeklyReportPublishDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 表格 B 列中的姓名。未提供时仅允许从单一项目人员推断。 */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  person?: string;

  /** 前端传入的飞书发布配置；未提供时兼容服务端配置。 */
  @IsOptional()
  @ValidateNested()
  @Type(() => WeeklyReportPublishSettingsDto)
  settings?: WeeklyReportPublishSettingsDto;
}
