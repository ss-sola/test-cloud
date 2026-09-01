import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
