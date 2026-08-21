import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** 所有服务的基础配置校验类，包含服务名、端口及可选的路由前缀/扫描模式。 */
export class CommonConfig {
  @IsString()
  @IsNotEmpty()
  ServiceName!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  Port!: number;

  @IsString()
  @IsOptional()
  GlobalPrefix?: string;

  @IsString()
  @IsOptional()
  Pattern?: string;
}

/** 带数据库连接的服务基础校验类，继承 CommonConfig。 */
export class DatabaseConfig extends CommonConfig {
  @IsString()
  @IsNotEmpty()
  DbDriver!: string;

  @IsString()
  @IsNotEmpty()
  DbHost!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  DbPort!: number;

  @IsString()
  @IsNotEmpty()
  DbUsername!: string;

  /** 密码允许为空字符串（兼容开发环境）。 */
  @IsString()
  DbPassword!: string;

  @IsString()
  @IsNotEmpty()
  DbDatabase!: string;
}
