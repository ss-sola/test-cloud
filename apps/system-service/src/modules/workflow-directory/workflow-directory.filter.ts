import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import type { Response } from 'express';
import { WORKFLOW_DIRECTORY_ERRORS } from '../../constants/workflow-directory.constants';
import { WorkflowDirectoryException } from './workflow-directory.exception';

const GENERIC_MESSAGES: Record<number, string> = {
  400: WORKFLOW_DIRECTORY_ERRORS.invalidRequest.message,
  404: '接口未找到',
  413: WORKFLOW_DIRECTORY_ERRORS.tooLarge.message,
  415: '请求内容类型不受支持',
};

/**
 * 固定目录接口专用异常转换：只输出受控异常的固定文案与版本，
 * 不调用会记录请求体、校验 value/target 及异常栈的公共 filter。
 */
@Catch()
export class WorkflowDirectoryExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WorkflowDirectoryExceptionFilter.name);

  /** 转换为脱敏响应；版本冲突在顶层附带 revision，日志仅保留状态码与异常类型。 */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status: number = WORKFLOW_DIRECTORY_ERRORS.internal.status;
    let message: string = WORKFLOW_DIRECTORY_ERRORS.internal.message;
    let revision: string | null | undefined;

    if (exception instanceof WorkflowDirectoryException) {
      status = exception.getStatus();
      message = exception.message;
      revision = exception.revision;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = GENERIC_MESSAGES[status] ?? (status < 500 ? '请求无法处理' : message);
    }

    const type = exception instanceof Error ? exception.constructor.name : typeof exception;
    const line = `工作流目录请求失败：status=${status} type=${type}`;
    if (status >= 500) this.logger.error(line);
    else this.logger.warn(line);

    if (response.headersSent) return;
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({
      ...ResponseUtil.error(message, status),
      ...(revision !== undefined && { revision }),
    });
  }
}
