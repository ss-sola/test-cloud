import * as path from 'path';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import chalk from 'chalk';

const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'verbose'] as const;

export type ConsoleLogLevel = (typeof LOG_LEVELS)[number];

// 获取当前年月作为目录（如 logs/2025-05）
const now = new Date();
const yearMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getDate()}`;
const logDir = path.join(process.cwd(), 'logs', yearMonth);

function createConsoleTransport(level: ConsoleLogLevel) {
  return new winston.transports.Console({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ level: currentLevel, message, timestamp, context }) => {
        const time = chalk.gray(`[${timestamp}]`);
        const { lvl, msg } = colorizeLevelAndMessage(currentLevel, message as string);
        const ctx = context ? chalk.yellow(`[${context}]`) : '';
        return `${time} ${lvl} ${ctx} ${msg}`;
      }),
    ),
  });
}

// 文件输出（无颜色）
const fileFormat = winston.format.printf(({ level, message, timestamp, context }) => {
  return `[${timestamp}] ${level.toUpperCase()} ${context ? `[${context}]` : ''} ${message}`;
});
function levelFilter(level: string) {
  return winston.format((info) => {
    return info.level === level ? info : false;
  })();
}

// 创建每个等级对应的 transport
const errorTransport = createDailyRotateTransport('error');
const warnTransport = createDailyRotateTransport('warn');
const infoTransport = createDailyRotateTransport('info');
const debugTransport = createDailyRotateTransport('debug');
// 通用的文件 transport 生成函数
function createDailyRotateTransport(level: string): DailyRotateFile {
  return new DailyRotateFile({
    level,
    dirname: logDir,
    filename: `%DATE%-${level}.log`,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: undefined,
    maxFiles: '30d',
    format: winston.format.combine(
      levelFilter(level), // 👈 添加过滤器
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      fileFormat,
    ),
    options: { flags: 'a', mode: 0o666 },
  });
}

// 日志等级着色
function colorizeLevelAndMessage(level: string, message: string) {
  switch (level) {
    case 'error':
      return {
        lvl: chalk.red.bold(level.toUpperCase()),
        msg: chalk.red.bold(message),
      };
    case 'warn':
      return {
        lvl: chalk.yellow.bold(level.toUpperCase()),
        msg: chalk.yellow.bold(message),
      };
    case 'info':
      return {
        lvl: chalk.green.bold(level.toUpperCase()),
        msg: chalk.green.bold(message),
      };
    case 'debug':
      return {
        lvl: chalk.cyan.bold(level.toUpperCase()),
        msg: chalk.cyan.bold(message),
      };
    case 'verbose':
      return {
        lvl: chalk.magenta.bold(level.toUpperCase()),
        msg: chalk.magenta.bold(message),
      };
    default:
      return {
        lvl: chalk.white(level.toUpperCase()),
        msg: chalk.white(message),
      };
  }
}

export function normalizeConsoleLogLevel(value?: string): ConsoleLogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized && LOG_LEVELS.includes(normalized as ConsoleLogLevel)) {
    return normalized as ConsoleLogLevel;
  }

  return 'debug';
}

/** 判断当前日志级别是否允许输出 debug 访问日志。 */
export function shouldLogHttpAccess(value?: string): boolean {
  const normalized = normalizeConsoleLogLevel(value);
  return normalized === 'debug' || normalized === 'verbose';
}

export function createWinstonConfig(
  consoleLevel?: string,
  enableConsole = true,
): winston.LoggerOptions {
  const resolvedConsoleLevel = normalizeConsoleLogLevel(consoleLevel);

  return {
    transports: [
      ...(enableConsole ? [createConsoleTransport(resolvedConsoleLevel)] : []),
      errorTransport,
      infoTransport,
      warnTransport,
      debugTransport,
    ],
    silent: false,
    exitOnError: false,
  };
}
