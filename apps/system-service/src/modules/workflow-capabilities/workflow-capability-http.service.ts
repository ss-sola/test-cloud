import { Injectable } from '@nestjs/common';
import { ConfigKeys, ResponseUtil, getConfig } from '@nest-cloud/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  WORKFLOW_CAPABILITY_API_PATH,
  WORKFLOW_CAPABILITY_LIMITS,
  WORKFLOW_CAPABILITY_ROUTES,
} from '../../constants/workflow-capability.constants';
import { AiTextDto } from './dto/ai-text.dto';
import { FeishuFindRowDto, FeishuWriteCellsDto } from './dto/feishu-sheet.dto';
import { GithubCommitsDto } from './dto/github-commits.dto';

const ROUTE_PATTERN = /^\/([a-z-]+)\/?$/i;

const ROUTE_DTOS: Record<string, new () => object> = {
  [WORKFLOW_CAPABILITY_ROUTES.githubCommits]: GithubCommitsDto,
  [WORKFLOW_CAPABILITY_ROUTES.aiText]: AiTextDto,
  [WORKFLOW_CAPABILITY_ROUTES.feishuFindRow]: FeishuFindRowDto,
  [WORKFLOW_CAPABILITY_ROUTES.feishuWriteCells]: FeishuWriteCellsDto,
};

type BodyParserError = { status?: number; type?: string };

/**
 * 挂载原子能力专用 HTTP 边界：路由级 JSON parser、no-store、请求体擦除和严格字段校验。
 * 请求体含 token、secret、提示词和单元格内容，必须在 Nest 默认 parser 与公共日志之前处理，
 * 失败时直接返回固定文案，不进入会记录请求体的公共 filter 与 ValidationPipe。
 */
@Injectable()
export class WorkflowCapabilityHttpService {
  private mounted = false;

  /** 在能力路径前缀上串联路由检查、专用 parser、parser 错误转换、对象体检查和严格字段校验。 */
  mount(app: { use: (...args: any[]) => unknown }): void {
    if (this.mounted) return;

    const globalPrefix = getConfig<string>(ConfigKeys.GlobalPrefix, '', false);
    const normalizedPrefix = globalPrefix ? `/${globalPrefix.replace(/^\/+|\/+$/g, '')}` : '';

    // 改名避免 Nest 误判全局 parser 已注册而跳过其他路由的默认 parser
    const bodyParser = json({
      limit: WORKFLOW_CAPABILITY_LIMITS.maxBodyBytes,
      inflate: false,
      type: 'application/json',
    });
    const capabilityJsonParser = (req: Request, res: Response, next: NextFunction) =>
      bodyParser(req, res, next);

    // 无前缀的旧地址在此结束，避免其 404 进入公共正文日志
    if (normalizedPrefix) {
      app.use(WORKFLOW_CAPABILITY_API_PATH, (req: Request, res: Response) => {
        req.body = undefined;
        res.setHeader('Cache-Control', 'no-store');
        this.reject(res, 404, '接口未找到');
      });
    }

    app.use(
      `${normalizedPrefix}${WORKFLOW_CAPABILITY_API_PATH}`,
      this.guardRequest,
      capabilityJsonParser,
      this.handleParserError,
      this.requireObjectBody,
      this.validateBody,
    );
    this.mounted = true;
  }

  /**
   * 创建随客户端断开而取消的信号：监听 req.aborted 与未写完的 res.close。
   * 不监听 req.close，因为正常的 POST 读完请求体后也会触发它。
   */
  createAbortSignal(req: Request, res: Response): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort();
    (req as NodeJS.EventEmitter).once('aborted', abort);
    res.once('close', () => {
      if (!res.writableEnded) abort();
    });
    return controller.signal;
  }

  /** 设置 no-store 与 finish/close 前清空 body，再拒绝未知子路径、非 POST 和非 JSON 请求。 */
  private readonly guardRequest = (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    // 先于公共访问日志的 finish 监听清空原文，覆盖正常结束与连接中断
    const clearBody = () => {
      req.body = undefined;
    };
    res.prependOnceListener('finish', clearBody);
    res.prependOnceListener('close', clearBody);

    const route = ROUTE_PATTERN.exec(req.path)?.[1]?.toLowerCase();
    if (!route || !ROUTE_DTOS[route]) {
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

  /** 将 parser 异常转换为不含原文片段的固定响应。 */
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

  /**
   * 以不做隐式转换、禁止未知字段（含嵌套）的方式校验 DTO。
   * 全局 ValidationPipe 会静默剔除未知字段并允许隐式转换，所以严格校验放在此处；失败只返回固定文案。
   */
  private readonly validateBody = (req: Request, res: Response, next: NextFunction): void => {
    const route = ROUTE_PATTERN.exec(req.path)?.[1]?.toLowerCase() ?? '';
    const instance = plainToInstance(ROUTE_DTOS[route], req.body as object, {
      enableImplicitConversion: false,
    });
    const errors = validateSync(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    });
    if (errors.length > 0) {
      this.reject(res, 400, '请求参数不合法');
      return;
    }
    next();
  };

  /** 输出不包含请求原文的统一 HTTP 错误。 */
  private reject(res: Response, status: number, message: string): void {
    res.status(status).json(ResponseUtil.error(message, status));
  }
}
