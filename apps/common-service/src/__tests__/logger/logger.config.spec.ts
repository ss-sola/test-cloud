import { describe, it, expect, vi, beforeEach } from 'vitest';
const {
  consoleTransportMock,
  dailyRotateFileMock,
  formatFactoryMock,
  combineMock,
  timestampMock,
  printfMock,
  loggerErrorMock,
  createLoggerMock,
} = vi.hoisted(() => {
  const consoleTransportMock = vi.fn(function (this: any, options: unknown) {
    this.type = 'console';
    this.options = options;
  });
  const dailyRotateFileMock = vi.fn(function (this: any, options: unknown) {
    this.type = 'daily-rotate';
    this.options = options;
  });
  const formatFactoryMock = vi.fn((transformer: unknown) => () => ({
    type: 'format-transform',
    transformer,
  }));
  const combineMock = vi.fn((...args: unknown[]) => ({
    type: 'combine',
    args,
  }));
  const timestampMock = vi.fn((options?: unknown) => ({
    type: 'timestamp',
    options,
  }));
  const printfMock = vi.fn((formatter: unknown) => ({
    type: 'printf',
    formatter,
  }));
  const loggerErrorMock = vi.fn();
  const createLoggerMock = vi.fn(() => ({
    info: vi.fn(),
    error: loggerErrorMock,
    warn: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  }));
  return {
    consoleTransportMock,
    dailyRotateFileMock,
    formatFactoryMock,
    combineMock,
    timestampMock,
    printfMock,
    loggerErrorMock,
    createLoggerMock,
  };
});

vi.mock('winston', () => ({
  createLogger: createLoggerMock,
  transports: {
    Console: consoleTransportMock,
  },
  format: Object.assign(formatFactoryMock, {
    combine: combineMock,
    timestamp: timestampMock,
    printf: printfMock,
  }),
}));

vi.mock('winston-daily-rotate-file', () => ({
  default: dailyRotateFileMock,
}));

import {
  createWinstonConfig,
  normalizeConsoleLogLevel,
  shouldLogHttpAccess,
} from '../../logger/logger.config';
import { AppLogger } from '../../logger/logger.service';

describe('logger.config', () => {
  beforeEach(() => {
    consoleTransportMock.mockClear();
  });

  it('should normalize console log level with fallback', () => {
    expect(normalizeConsoleLogLevel(' INFO ')).toBe('info');
    expect(normalizeConsoleLogLevel('verbose')).toBe('verbose');
    expect(normalizeConsoleLogLevel('bad-level')).toBe('debug');
    expect(normalizeConsoleLogLevel()).toBe('debug');
  });

  it('should only enable http access logs at debug or verbose level', () => {
    expect(shouldLogHttpAccess('debug')).toBe(true);
    expect(shouldLogHttpAccess('verbose')).toBe(true);
    expect(shouldLogHttpAccess('info')).toBe(false);
  });

  it('should build winston config with or without console transport', () => {
    const withConsole = createWinstonConfig('INFO', true);
    const withoutConsole = createWinstonConfig(undefined, false);

    expect(consoleTransportMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'info' }));
    expect(withConsole.transports).toHaveLength(5);
    expect(withoutConsole.transports).toHaveLength(4);
  });

  it('should serialize Error objects with stack and cause', () => {
    loggerErrorMock.mockClear();
    const logger = new AppLogger({ enableConsole: false });
    const rootCause = new Error('root-cause');
    const error = new Error('boot failed', { cause: rootCause });

    logger.error(error, undefined, 'Bootstrap');

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('"message":"boot failed"'),
    );
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining('"name":"Error"'));
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('"cause":{"name":"Error","message":"root-cause"'),
    );
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('"stack":"Error: boot failed'),
    );
  });
});
