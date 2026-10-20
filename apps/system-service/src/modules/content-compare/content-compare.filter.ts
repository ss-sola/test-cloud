import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import type { Response } from 'express';
import { CONTENT_COMPARE_LIMITS } from '../../constants/content-compare.constants';
import { ContentCompareException } from './content-compare.exception';
import type { CompareInputErrors, CompareParseError } from './content-compare.types';

const GENERIC_MESSAGES: Record<number, string> = {
  400: '请求参数不合法',
  404: '接口未找到',
  413: '请求体超过大小限制',
  415: '请求内容类型不受支持',
};

/**
 * 比较接口专用异常转换：只输出固定文案和白名单字段，
 * 不调用会记录请求体、校验 value/target 及异常栈的公共 filter。
 */
@Catch()
export class ContentCompareExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ContentCompareExceptionFilter.name);

  /** 将比较异常转换为脱敏响应，并仅记录状态与异常类型。 */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let message = '服务器内部错误';
    let errors: CompareInputErrors | undefined;

    if (exception instanceof ContentCompareException) {
      status = exception.getStatus();
      message = exception.message;
      errors = this.sanitizeErrors(exception.errors);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = GENERIC_MESSAGES[status] ?? (status < 500 ? '请求无法处理' : message);
    }

    // 日志只保留状态码与异常类型，不输出消息、栈、请求体和校验目标
    const type = exception instanceof Error ? exception.constructor.name : typeof exception;
    const line = `内容比较请求失败：status=${status} type=${type}`;
    if (status >= 500) this.logger.error(line);
    else this.logger.warn(line);

    if (response.headersSent) return;
    response
      .status(status)
      .json({ ...ResponseUtil.error(message, status), ...(errors && { errors }) });
  }

  /** 按白名单重建两侧错误，丢弃未知字段并限制条数。 */
  private sanitizeErrors(errors?: CompareInputErrors): CompareInputErrors | undefined {
    if (!errors) return undefined;
    const pick = (items: CompareParseError[] = []): CompareParseError[] =>
      items.slice(0, CONTENT_COMPARE_LIMITS.maxErrors).map((item) => {
        const safe: CompareParseError = { code: String(item.code), message: String(item.message) };
        for (const field of ['line', 'column', 'previousLine'] as const) {
          if (Number.isInteger(item[field])) safe[field] = item[field];
        }
        return safe;
      });
    return { left: pick(errors.left), right: pick(errors.right) };
  }
}
