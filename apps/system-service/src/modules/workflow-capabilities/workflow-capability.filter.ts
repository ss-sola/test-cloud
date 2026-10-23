import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import type { Response } from 'express';
import { AiTextClientException } from '../../client/ai/ai-text-client.exception';
import { WorkflowCapabilityException } from './workflow-capability.exception';

const GENERIC_MESSAGES: Record<number, string> = {
  400: '请求参数不合法',
  404: '接口未找到',
  413: '请求体超过大小限制',
  415: '请求内容类型不受支持',
};

/**
 * 原子能力专用异常转换：只输出受控异常的固定文案或通用文案，
 * 不调用会记录请求体、校验 value/target 及异常栈的公共 filter。
 */
@Catch()
export class WorkflowCapabilityExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WorkflowCapabilityExceptionFilter.name);

  /** 转换为脱敏响应，日志仅保留状态码与异常类型。 */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let message = '服务器内部错误';

    if (
      exception instanceof WorkflowCapabilityException ||
      exception instanceof AiTextClientException
    ) {
      status = exception.getStatus();
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = GENERIC_MESSAGES[status] ?? (status < 500 ? '请求无法处理' : message);
    }

    const type = exception instanceof Error ? exception.constructor.name : typeof exception;
    const line = `工作流能力请求失败：status=${status} type=${type}`;
    if (status >= 500) this.logger.error(line);
    else this.logger.warn(line);

    if (response.headersSent) return;
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json(ResponseUtil.error(message, status));
  }
}
