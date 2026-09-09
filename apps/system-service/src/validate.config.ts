import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** system-service 仅校验启动所需的 HTTP 端口和共享 Redis URL。业务运行参数由 HTTP 请求提供。 */
export class SystemServiceConfig {
  @Min(1)
  @Max(65535)
  @IsInt()
  Port!: number;

  @IsOptional()
  @IsString()
  SessionRedisUrl?: string;
}
