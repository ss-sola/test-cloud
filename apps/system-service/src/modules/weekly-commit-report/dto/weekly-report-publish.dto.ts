import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class WeeklyReportPublishSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  appId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  appSecret?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  wikiUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;
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
