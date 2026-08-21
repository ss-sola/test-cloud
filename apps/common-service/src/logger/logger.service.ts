import { Injectable, LoggerService } from '@nestjs/common';
import * as winston from 'winston';
import { createWinstonConfig } from './logger.config';
import { getConfig } from '@/config-center';
import { ConfigKeys } from '@/config/keys';

type AppLoggerOptions = {
  consoleLevel?: string;
  enableConsole?: boolean;
};

@Injectable()
export class AppLogger implements LoggerService {
  private logger: winston.Logger;

  constructor(options: AppLoggerOptions = {}) {
    this.logger = winston.createLogger(
      createWinstonConfig(
        options.consoleLevel ?? this.resolveConsoleLevel(),
        options.enableConsole ?? this.resolveEnableConsole(),
      ),
    );

    // 处理未捕获的Promise异常
    process.on('unhandledRejection', (reason: unknown) => {
      this.error(
        `Unhandled Rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
        reason instanceof Error ? reason.stack : undefined,
      );
    });

    // 处理未捕获的异常
    process.on('uncaughtException', (error: Error) => {
      this.error('Uncaught Exception:', error.message);
    });
  }

  log(message: any, context?: string) {
    this.logger.info(this.formatMessage(message, context));
  }

  error(message: any, trace?: string, context?: string) {
    this.logger.error(this.formatMessage(message, context));
    if (trace) {
      this.logger.error(trace);
    }
  }

  warn(message: any, context?: string) {
    this.logger.warn(this.formatMessage(message, context));
  }

  debug(message: any, context?: string) {
    this.logger.debug(this.formatMessage(message, context));
  }

  verbose(message: any, context?: string) {
    this.logger.verbose(this.formatMessage(message, context));
  }

  private resolveConsoleLevel(): string | undefined {
    try {
      return getConfig<string>(ConfigKeys.ConsoleLogLevel, 'info');
    } catch {
      return undefined;
    }
  }

  private resolveEnableConsole(): boolean {
    try {
      return getConfig<string>(ConfigKeys.NodeEnv, 'development', false) !== 'production';
    } catch {
      return true;
    }
  }

  private formatMessage(message: any, context?: string): string {
    const normalizedMessage = this.stringifyMessage(message);
    return context ? `[${context}] ${normalizedMessage}` : normalizedMessage;
  }

  private stringifyMessage(message: any): string {
    if (message instanceof Error) {
      return JSON.stringify(this.serializeError(message));
    }
    if (typeof message === 'object' && message !== null) {
      return JSON.stringify(message, this.jsonReplacer);
    }
    return String(message);
  }

  private serializeError(error: Error): Record<string, unknown> {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };

    if (error.stack) {
      serialized.stack = error.stack;
    }

    const errorWithCause = error as Error & { cause?: unknown };
    if (errorWithCause.cause !== undefined) {
      serialized.cause =
        errorWithCause.cause instanceof Error
          ? this.serializeError(errorWithCause.cause)
          : errorWithCause.cause;
    }

    for (const [key, value] of Object.entries(error)) {
      if (!(key in serialized)) {
        serialized[key] = value;
      }
    }

    return serialized;
  }

  private readonly jsonReplacer = (_key: string, value: unknown) => {
    if (value instanceof Error) {
      return this.serializeError(value);
    }
    return value;
  };
}
