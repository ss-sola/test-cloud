import { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

export type IOptions = {
  AppModule: Type<any>;
  validateConfig?: new () => object;
  configureApp?: (app: NestExpressApplication) => void | Promise<void>;
  /** 跳过内置的 CurrentAccountMiddleware 注册（服务自行管理时使用） */
  skipCurrentAccountMiddleware?: boolean;
};
