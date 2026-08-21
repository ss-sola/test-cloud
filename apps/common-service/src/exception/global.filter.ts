import { ResponseUtil } from '../util/response.util';
import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * @Description: 全局异常处理器
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter<HttpException> {
  private readonly logger: Logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // request.pass = false;
    let status = 500;

    try {
      if (exception.getStatus) {
        status = exception.getStatus();
      }
      // 正常业务代码抛出的异常
      if (exception instanceof NotFoundException) {
        this.logger.warn(exception.message);

        response.status(status).json(ResponseUtil.error('接口未找到', status));
      } else if (exception instanceof BadRequestException) {
        response.status(status).json(ResponseUtil.error('请求格式错误', status));
      } else {
        const status = exception.getStatus();
        response.status(status).json(ResponseUtil.error(exception.message, status));
      }
    } catch (e: unknown) {
      response.status(500).json(ResponseUtil.error(exception?.message, 500));
    } finally {
      const obj = {
        url: request.originalUrl,
        method: request.method,
        params: request.params,
        query: request.query,
        body: request.body || {},
        ip: request.ip,
        status: status,
      };
      this.logger.error(`${JSON.stringify(obj)}\n ${exception?.stack}`);
    }
  }
}
