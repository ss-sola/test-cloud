import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import type { Response } from 'express';
import { WORKFLOW_EXECUTION_ERRORS } from '../../constants/workflow-execution.constants';
import { WorkflowExecutionException } from './workflow-execution.exception';

const GENERIC_MESSAGES: Record<number, string> = {
  400: WORKFLOW_EXECUTION_ERRORS.invalidRequest.message,
  404: '接口未找到',
  413: WORKFLOW_EXECUTION_ERRORS.tooLarge.message,
  415: '请求内容类型不受支持',
};

/**
 * 工作流执行接口专用异常转换：只放行受控 WorkflowExecutionException 的固定文案，
 * 其他异常一律转换为通用文案；不调用会记录请求体、校验 value/target 及异常栈的公共 filter。
 */
@Catch()
export class WorkflowExecutionExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WorkflowExecutionExceptionFilter.name);

  /** 转换为脱敏响应，日志仅保留状态码与异常类型。 */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status: number = WORKFLOW_EXECUTION_ERRORS.internal.status;
    let message: string = WORKFLOW_EXECUTION_ERRORS.internal.message;

    if (exception instanceof WorkflowExecutionException) {
      status = exception.getStatus();
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = GENERIC_MESSAGES[status] ?? (status < 500 ? '请求无法处理' : message);
    }

    const type = exception instanceof Error ? exception.constructor.name : typeof exception;
    const line = `工作流执行请求失败：status=${status} type=${type}`;
    if (status >= 500) this.logger.error(line);
    else this.logger.warn(line);

    if (response.headersSent) {
      // 流式响应已开始时无法再写 JSON，直接结束连接，避免客户端一直等待
      if (!response.writableEnded) response.end();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json(ResponseUtil.error(message, status));
  }
}
