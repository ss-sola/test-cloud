import { Injectable } from '@nestjs/common';
import { ConfigKeys, ResponseUtil, getConfig } from '@nest-cloud/common';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  CONTENT_COMPARE_API_PATH,
  CONTENT_COMPARE_LIMITS,
} from '../../constants/content-compare.constants';

const COMPARE_ROUTE_PATTERN = /^\/(json|env)\/?$/i;

type BodyParserError = { status?: number; type?: string };

/**
 * 挂载比较接口专用 HTTP 边界：路由级 JSON parser、no-store 与请求体隐私保护。
 * 必须在 Nest 默认 parser 之前挂载，处理失败时直接返回固定文案，不进入会记录请求体的公共 filter。
 */
@Injectable()
export class ContentCompareHttpService {
  private mounted = false;

  /** 在比较路径前缀上串联路由检查、专用 parser、parser 错误转换和对象体校验。 */
  mount(app: { use: (...args: any[]) => unknown }): void {
    if (this.mounted) return;

    const globalPrefix = getConfig<string>(ConfigKeys.GlobalPrefix, '', false);
    const normalizedPrefix = globalPrefix ? `/${globalPrefix.replace(/^\/+|\/+$/g, '')}` : '';

    // Nest 以中间件名 jsonParser 判断全局 parser 是否已注册；这里改名，避免默认 parser 被误判跳过而影响其他路由
    const bodyParser = json({
      limit: CONTENT_COMPARE_LIMITS.maxBodyBytes,
      inflate: false,
      type: 'application/json',
    });
    const compareJsonParser = (req: Request, res: Response, next: NextFunction) =>
      bodyParser(req, res, next);

    // 旧的无前缀地址也在此结束，避免其 404 进入公共正文日志。
    if (normalizedPrefix) {
      app.use(CONTENT_COMPARE_API_PATH, (req: Request, res: Response) => {
        req.body = undefined;
        res.setHeader('Cache-Control', 'no-store');
        this.reject(res, 404, '接口未找到');
      });
    }

    app.use(
      `${normalizedPrefix}${CONTENT_COMPARE_API_PATH}`,
      this.guardRequest,
      compareJsonParser,
      this.handleParserError,
      this.requireObjectBody,
    );
    this.mounted = true;
  }

  /** 设置 no-store 与 finish 前清空 body，再依次拒绝未知子路径、非 POST 和非 JSON 请求。 */
  private readonly guardRequest = (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    // 先于公共访问日志的 finish 监听清空原文，覆盖正常结束与连接中断
    const clearBody = () => {
      req.body = undefined;
    };
    res.prependOnceListener('finish', clearBody);
    res.prependOnceListener('close', clearBody);

    if (!COMPARE_ROUTE_PATTERN.test(req.path)) {
      this.reject(res, 404, '接口未找到');
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      this.reject(res, 405, '请求方法不受支持');
      return;
    }
    const mediaType = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (mediaType !== 'application/json') {
      this.reject(res, 415, '请求内容类型必须为 application/json');
      return;
    }
    next();
  };

  /** 将 parser 异常转换为不含原文片段的 400/413/415 响应。 */
  private readonly handleParserError = (
    error: BodyParserError,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    if (error.type === 'entity.too.large' || error.status === 413) {
      this.reject(res, 413, '请求体超过大小限制');
    } else if (error.status === 415) {
      this.reject(res, 415, '请求内容类型或编码不受支持');
    } else if (error.status === undefined || error.status >= 500) {
      this.reject(res, 500, '服务器内部错误');
    } else {
      this.reject(res, 400, '请求体不是有效的 JSON 对象');
    }
  };

  /** 请求体必须是 JSON 对象，数组、null、空体不进入 DTO 校验。 */
  private readonly requireObjectBody = (req: Request, res: Response, next: NextFunction): void => {
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      this.reject(res, 400, '请求体必须是 JSON 对象');
      return;
    }
    next();
  };

  /** 输出不包含请求原文的统一 HTTP 错误。 */
  private reject(res: Response, status: number, message: string): void {
    res.status(status).json(ResponseUtil.error(message, status));
  }
}
