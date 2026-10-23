import { Injectable } from '@nestjs/common';
import { ConfigKeys, ResponseUtil, getConfig } from '@nest-cloud/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  WORKFLOW_DIRECTORY_API_PATH,
  WORKFLOW_DIRECTORY_ERRORS,
  WORKFLOW_DIRECTORY_LIMITS,
  WORKFLOW_DIRECTORY_ROUTES,
  WORKFLOW_DIRECTORY_ROUTE_METHODS,
} from '../../constants/workflow-directory.constants';
import {
  WorkflowDirectoryFileQueryDto,
  WorkflowDirectorySaveDto,
} from './dto/workflow-directory.dto';

const ROUTE_PATTERN = /^\/([a-z]+)\/?$/i;

type BodyParserError = { status?: number; type?: string };

/**
 * 挂载固定目录接口专用 HTTP 边界：no-store、来源限制、路由级 JSON parser、请求体擦除和严格字段校验。
 * 请求体含工作流原文，必须在 Nest 默认 parser 与公共日志之前处理，
 * 失败时直接返回固定文案，不进入会记录请求体的公共 filter 与 ValidationPipe。
 */
@Injectable()
export class WorkflowDirectoryHttpService {
  private mounted = false;

  // 改名避免 Nest 误判全局 parser 已注册而跳过其他路由的默认 parser
  private readonly bodyParser = json({
    limit: WORKFLOW_DIRECTORY_LIMITS.maxBodyBytes,
    inflate: false,
    type: 'application/json',
  });

  /** 在固定目录路径前缀上串联路由与来源检查、专用 parser、parser 错误转换和严格字段校验。 */
  mount(app: { use: (...args: any[]) => unknown }): void {
    if (this.mounted) return;

    const globalPrefix = getConfig<string>(ConfigKeys.GlobalPrefix, '', false);
    const normalizedPrefix = globalPrefix ? `/${globalPrefix.replace(/^\/+|\/+$/g, '')}` : '';

    // 无前缀的旧地址在此结束，避免其 404 进入公共正文日志
    if (normalizedPrefix) {
      app.use(WORKFLOW_DIRECTORY_API_PATH, (req: Request, res: Response) => {
        req.body = undefined;
        res.setHeader('Cache-Control', 'no-store');
        this.reject(res, 404, '接口未找到');
      });
    }

    app.use(
      `${normalizedPrefix}${WORKFLOW_DIRECTORY_API_PATH}`,
      this.guardRequest,
      this.parseBody,
      this.handleParserError,
      this.validateRequest,
    );
    this.mounted = true;
  }

  /**
   * 设置 no-store 与 finish/close 前清空 body，再依次拒绝未知路径、不支持的方法、跨来源请求、
   * 带正文的 GET 和非 JSON 的 POST。
   */
  private readonly guardRequest = (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    // 先于公共访问日志的 finish 监听清空原文，覆盖正常结束与连接中断
    const clearBody = () => {
      req.body = undefined;
    };
    res.prependOnceListener('finish', clearBody);
    res.prependOnceListener('close', clearBody);

    const methods = WORKFLOW_DIRECTORY_ROUTE_METHODS[this.routeOf(req)];
    if (!methods) {
      this.reject(res, 404, '接口未找到');
      return;
    }
    if (!methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      this.reject(res, 405, '请求方法不受支持');
      return;
    }
    if (!this.isSameOrigin(req)) {
      this.reject(res, 403, WORKFLOW_DIRECTORY_ERRORS.forbiddenOrigin.message);
      return;
    }
    if (req.method === 'GET') {
      if (
        req.headers['transfer-encoding'] !== undefined ||
        Number(req.headers['content-length'] ?? 0) > 0
      ) {
        this.reject(res, 400, WORKFLOW_DIRECTORY_ERRORS.invalidRequest.message);
        return;
      }
      next();
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

  /** 仅 POST 需要解析 JSON 正文。 */
  private readonly parseBody = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'POST') this.bodyParser(req, res, next);
    else next();
  };

  /** 将 parser 异常转换为不含原文片段的固定响应。 */
  private readonly handleParserError = (
    error: BodyParserError,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    if (error.type === 'entity.too.large' || error.status === 413) {
      this.reject(res, 413, WORKFLOW_DIRECTORY_ERRORS.tooLarge.message);
    } else if (error.status === 415) {
      this.reject(res, 415, '请求内容类型或编码不受支持');
    } else if (error.status === undefined || error.status >= 500) {
      this.reject(res, 500, WORKFLOW_DIRECTORY_ERRORS.internal.message);
    } else {
      this.reject(res, 400, '请求体不是有效的 JSON 对象');
    }
  };

  /**
   * 以不做隐式转换、禁止未知字段的方式校验 query 或 body。
   * 全局 ValidationPipe 会静默剔除未知字段并允许隐式转换，所以严格校验放在此处；失败只返回固定文案。
   */
  private readonly validateRequest = (req: Request, res: Response, next: NextFunction): void => {
    const route = this.routeOf(req);
    let valid: boolean;
    if (req.method === 'POST') {
      valid = this.isStrictlyValid(WorkflowDirectorySaveDto, req.body);
    } else if (route === WORKFLOW_DIRECTORY_ROUTES.document) {
      valid = this.isStrictlyValid(WorkflowDirectoryFileQueryDto, { ...req.query });
    } else {
      valid = Object.keys(req.query).length === 0;
    }
    if (!valid) {
      this.reject(res, 400, WORKFLOW_DIRECTORY_ERRORS.invalidRequest.message);
      return;
    }
    next();
  };

  private routeOf(req: Request): string {
    return ROUTE_PATTERN.exec(req.path)?.[1]?.toLowerCase() ?? '';
  }

  /** 浏览器携带的 Origin 须与当前 Host 一致，Sec-Fetch-Site 不能是跨站；非浏览器客户端不带这两个头。 */
  private isSameOrigin(req: Request): boolean {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      return new URL(origin).host === req.headers.host?.toLowerCase();
    } catch {
      return false;
    }
  }

  /** 必须是 JSON 对象，且字段完整、类型严格、不含未知字段。 */
  private isStrictlyValid(dto: new () => object, value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const instance = plainToInstance(dto, value, { enableImplicitConversion: false });
    return (
      validateSync(instance, {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        validationError: { target: false, value: false },
      }).length === 0
    );
  }

  /** 输出不包含请求原文的统一 HTTP 错误。 */
  private reject(res: Response, status: number, message: string): void {
    res.status(status).json(ResponseUtil.error(message, status));
  }
}
