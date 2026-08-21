import { ModuleRef, NestFactory } from '@nestjs/core';

import { NestExpressApplication } from '@nestjs/platform-express';
import { AppLogger } from './logger/logger.service';
import { shouldLogHttpAccess } from './logger/logger.config';
import { HttpException, HttpStatus, ValidationPipe } from '@nestjs/common';
import { GlobalExceptionFilter } from './exception/global.filter';
import { register } from './register';
import { IOptions } from './type';
import { setOptions } from './config-center/options';
import { getConfig, initConfigCenter, validateConfig } from './config-center';
import { ConfigKeys } from './config/keys';
import { ContextService } from './context/context.service';
import { NextFunction, Request, Response } from 'express';
import { AfterAppBootstrapRunner } from './ext/after-application-bootstrap.runner';
import { GlobalStore } from './context/global.service';
import {
  SHARED_AUTH_SESSION_COOKIE_NAME,
  SHARED_AUTH_SESSION_KEY_PREFIX,
  SHARED_AUTH_SESSION_SECRET,
  SHARED_AUTH_SESSION_REDIS_URL,
  SHARED_AUTH_SESSION_SAME_SITE,
  SHARED_AUTH_SESSION_SECURE,
  SHARED_AUTH_SESSION_TTL_MS,
} from './system-auth/system-auth.constants';
import { createRedisSession } from './session/redis-session';

export async function bootstrap(options: IOptions) {
  const logger = new AppLogger();
  try {
    setOptions(options);
    await initConfigCenter();

    if (options.validateConfig) {
      validateConfig(options.validateConfig);
    }

    const port = getConfig<number>(ConfigKeys.Port);
    const globalPrefix = getConfig<string>(ConfigKeys.GlobalPrefix, '', false);
    const pattern = getConfig<string>(ConfigKeys.Pattern, undefined, false) || undefined;
    const consoleLogLevel = getConfig<string>(ConfigKeys.ConsoleLogLevel, 'info', false);
    const enableHttpAccessLog = shouldLogHttpAccess(consoleLogLevel);
    const normalizedGlobalPrefix = globalPrefix ? `/${globalPrefix.replace(/^\/+|\/+$/g, '')}` : '';

    const dynamicModule = await register(options.AppModule, pattern);

    const app = await NestFactory.create<NestExpressApplication>(dynamicModule, {
      bufferLogs: true, // 缓冲日志直到自定义日志器准备好
      logger,
    });

    if (globalPrefix) {
      app.setGlobalPrefix(globalPrefix);
    }
    app.enableCors({
      origin: true,
      credentials: true,
    });
    // 注入 session 中间件（仅当配置了 SessionSecret 时启用）

    app.use(
      createRedisSession({
        redisUrl: getConfig<string>(ConfigKeys.SessionRedisUrl, SHARED_AUTH_SESSION_REDIS_URL),
        secret: getConfig<string>(ConfigKeys.SessionSecret, SHARED_AUTH_SESSION_SECRET),
        cookieName: getConfig<string>(
          ConfigKeys.SessionCookieName,
          SHARED_AUTH_SESSION_COOKIE_NAME,
        ),
        ttlMs: getConfig<number>(ConfigKeys.SessionTtlMs, SHARED_AUTH_SESSION_TTL_MS),
        keyPrefix: getConfig<string>(ConfigKeys.SessionKeyPrefix, SHARED_AUTH_SESSION_KEY_PREFIX),
        sameSite: getConfig<string>(ConfigKeys.SessionSameSite, SHARED_AUTH_SESSION_SAME_SITE),
        secure: getConfig<boolean>(ConfigKeys.SessionSecure, SHARED_AUTH_SESSION_SECURE),
      }),
    );

    if (options.configureApp) {
      await options.configureApp(app);
    }

    // 添加全局中间件
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      await ContextService.setStore({ req, res }, next);
    });
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!enableHttpAccessLog) {
        next();
        return;
      }

      const startedAt = Date.now();
      res.on('finish', () => {
        const requestPath = req.originalUrl.split('?')[0] || req.originalUrl;
        if (
          (normalizedGlobalPrefix && !requestPath.startsWith(normalizedGlobalPrefix)) ||
          !req.route?.path
        ) {
          return;
        }

        const durationMs = Date.now() - startedAt;
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            routePath: req.route.path,
            params: req.params,
            query: req.query,
            body: req.body || {},
            ip: req.ip,
            status: res.statusCode,
            durationMs,
          },
          'HttpAccess',
        );
      });
      next();
    });
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true, // JS字面量对象转换为class
        transformOptions: {
          enableImplicitConversion: true, // 隐式转换
        },
        whitelist: true, // 剔除在验证类中没有任何装饰器的属性(可以继续走业务)
        forbidNonWhitelisted: false, // 存在非白名单属性时停止处理请求，并抛出错误
        validationError: {
          value: true,
          target: true,
        },
        // disableErrorMessages: true, // 为true时, 错误信息不回返回给前端 exception.response.message = 'Bad Request'
        // exceptionFactory: 自定义异常钩子,优先级高于disableErrorMessages
        exceptionFactory: (e) => {
          throw new HttpException(e, HttpStatus.BAD_REQUEST);
        },
      }),
    );
    GlobalStore.setModuleRef(app.get(ModuleRef));

    await app.init();
    await app.listen(port);
    const runner = app.get(AfterAppBootstrapRunner);
    await runner.run();
    logger.log(`服务启动成功: http://localhost:${port}`, 'Bootstrap');
    return app;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('服务启动失败', error.stack || error.message, 'Bootstrap');
    process.exit(1);
  }
}
