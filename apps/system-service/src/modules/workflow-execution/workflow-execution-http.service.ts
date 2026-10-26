import { Injectable, Logger } from '@nestjs/common';
import { ConfigKeys, ResponseUtil, getConfig } from '@nest-cloud/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  WORKFLOW_EXECUTION_API_PATH,
  WORKFLOW_EXECUTION_ERRORS,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_EXECUTION_ROUTES,
  WORKFLOW_EXECUTION_ROUTE_METHODS,
  WORKFLOW_EXECUTION_TOKEN_HEADER,
} from '../../constants/workflow-execution.constants';
import {
  WorkflowConfirmDto,
  WorkflowEventsQueryDto,
  WorkflowRunDto,
  WorkflowStatusQueryDto,
  WorkflowStopDto,
} from './dto/workflow-execution.dto';
import { WorkflowExecutionException } from './workflow-execution.exception';
import type { ExecutionEvent } from './workflow-execution.types';

const ROUTE_PATTERN = /^\/([a-z]+)\/?$/i;

const ROUTE_DTOS: Record<string, new () => object> = {
  [WORKFLOW_EXECUTION_ROUTES.run]: WorkflowRunDto,
  [WORKFLOW_EXECUTION_ROUTES.status]: WorkflowStatusQueryDto,
  [WORKFLOW_EXECUTION_ROUTES.events]: WorkflowEventsQueryDto,
  [WORKFLOW_EXECUTION_ROUTES.stop]: WorkflowStopDto,
  [WORKFLOW_EXECUTION_ROUTES.confirm]: WorkflowConfirmDto,
};

/** 公共 CORS 中间件在本边界之前已按任意 Origin 写入的响应头；本接口不开放跨源读取。 */
const CORS_RESPONSE_HEADERS = [
  'Access-Control-Allow-Origin',
  'Access-Control-Allow-Credentials',
  'Access-Control-Allow-Headers',
  'Access-Control-Allow-Methods',
  'Access-Control-Expose-Headers',
  'Access-Control-Max-Age',
];

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

type BodyParserError = { status?: number; type?: string };
type EventListener = (event: ExecutionEvent) => void;

/**
 * 挂载工作流执行接口专用 HTTP 边界：no-store、同源限制、去除公共 CORS 响应头、路由级 JSON parser、
 * 访问 token 头与请求体擦除、严格字段校验；同时负责 SSE 流的写出与订阅生命周期。
 * 请求体含工作流原文与凭据，必须在 Nest 默认 parser 与公共日志之前处理，
 * 失败时直接返回固定文案，不进入会记录请求体的公共 filter 与 ValidationPipe。
 */
@Injectable()
export class WorkflowExecutionHttpService {
  private readonly logger = new Logger(WorkflowExecutionHttpService.name);
  private mounted = false;

  // 访问 token 在边界处摘出请求头，避免公共日志、代理中间件和后续处理读取到明文
  private readonly tokens = new WeakMap<Request, string>();

  // 改名避免 Nest 误判全局 parser 已注册而跳过其他路由的默认 parser
  private readonly runParser = json({
    limit: WORKFLOW_EXECUTION_LIMITS.maxBodyBytes,
    inflate: false,
    type: 'application/json',
  });
  private readonly controlParser = json({
    limit: WORKFLOW_EXECUTION_LIMITS.controlBodyBytes,
    inflate: false,
    type: 'application/json',
  });

  /** 在执行接口路径前缀上串联路由与来源检查、专用 parser、parser 错误转换和严格字段校验。 */
  mount(app: { use: (...args: any[]) => unknown }): void {
    if (this.mounted) return;

    const globalPrefix = getConfig<string>(ConfigKeys.GlobalPrefix, '', false);
    const normalizedPrefix = globalPrefix ? `/${globalPrefix.replace(/^\/+|\/+$/g, '')}` : '';

    // 无前缀的旧地址在此结束，避免其 404 进入公共正文日志
    if (normalizedPrefix) {
      app.use(WORKFLOW_EXECUTION_API_PATH, (req: Request, res: Response) => {
        req.body = undefined;
        res.setHeader('Cache-Control', 'no-store');
        this.reject(res, 404, '接口未找到');
      });
    }

    app.use(
      `${normalizedPrefix}${WORKFLOW_EXECUTION_API_PATH}`,
      this.guardRequest,
      this.parseBody,
      this.handleParserError,
      this.validateRequest,
    );
    this.mounted = true;
  }

  /**
   * 取出并校验本次请求携带的访问 token。
   * 缺失或格式不符与任务不存在使用同一 404，不向调用方暴露差别。
   */
  takeAccessToken(req: Request): string {
    const token = this.tokens.get(req);
    this.tokens.delete(req);
    if (token === undefined || !WORKFLOW_EXECUTION_LIMITS.tokenPattern.test(token)) {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.notFound);
    }
    return token;
  }

  /**
   * 建立 SSE 流：先调用 subscribe 完成授权、额度与首个快照，首个事件写出前才发送响应头，
   * 因此注册失败时仍可返回 JSON 错误。订阅断开只退订，不影响任务；写缓冲未排空时再次写入即视为慢消费者并断开，
   * 由客户端重连后获得新的快照；任务终态后结束响应。
   */
  openEventStream(res: Response, subscribe: (listener: EventListener) => () => void): void {
    let unsubscribe: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let closed = false;
    let headersWritten = false;
    let blocked = false;

    const onDrain = () => {
      blocked = false;
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.off('close', cleanup);
      res.off('error', cleanup);
      res.off('drain', onDrain);
      unsubscribe?.();
    };
    /** 写入一帧；返回 false 表示已因慢消费者断开。 */
    const send = (frame: string): boolean => {
      if (!headersWritten) {
        headersWritten = true;
        res.writeHead(200, SSE_HEADERS);
        res.flushHeaders();
        res.socket?.setNoDelay(true);
      }
      if (blocked) {
        this.logger.warn('工作流事件订阅消费过慢，已断开连接');
        cleanup();
        res.destroy();
        return false;
      }
      // 单帧超过写缓冲水位时 write 必然返回 false，此时仅记录阻塞，下一次写入前仍未排空才断开
      if (!res.write(frame)) blocked = true;
      return true;
    };

    res.once('close', cleanup);
    res.once('error', cleanup);
    res.on('drain', onDrain);

    const listener: EventListener = (event) => {
      if (closed) return;
      const frame = `id: ${event.data.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
      if (!send(frame)) return;
      if (event.type === 'run-finished' || !event.data.running) {
        cleanup();
        res.end();
      }
    };

    try {
      unsubscribe = subscribe(listener);
    } catch (error) {
      closed = true;
      res.off('close', cleanup);
      res.off('error', cleanup);
      res.off('drain', onDrain);
      throw error;
    }
    // 订阅内同步推送了终态快照或连接已断开时，退订在此补做
    if (closed) {
      unsubscribe();
      return;
    }

    heartbeat = setInterval(() => {
      if (!closed) send(': ping\n\n');
    }, WORKFLOW_EXECUTION_LIMITS.heartbeatMs);
    heartbeat.unref();
  }

  /**
   * 设置 no-store、去除 CORS 响应头、摘出 token 头，并在 finish/close 前清空 body 与 query，
   * 再依次拒绝未知路径、不支持的方法、跨来源请求、带正文的 GET 和非 JSON 的 POST。
   */
  private readonly guardRequest = (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    for (const header of CORS_RESPONSE_HEADERS) res.removeHeader(header);
    this.captureAccessToken(req);

    // 先于公共访问日志的 finish 监听清空原文，覆盖正常结束与连接中断
    const clearRequest = () => {
      req.body = undefined;
      req.url = req.url.split('?')[0];
      req.originalUrl = req.originalUrl.split('?')[0];
    };
    res.prependOnceListener('finish', clearRequest);
    res.prependOnceListener('close', clearRequest);

    const methods = WORKFLOW_EXECUTION_ROUTE_METHODS[this.routeOf(req)];
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
      this.reject(res, 403, WORKFLOW_EXECUTION_ERRORS.forbiddenOrigin.message);
      return;
    }
    if (req.method === 'GET') {
      if (
        req.headers['transfer-encoding'] !== undefined ||
        Number(req.headers['content-length'] ?? 0) > 0
      ) {
        this.reject(res, 400, WORKFLOW_EXECUTION_ERRORS.invalidRequest.message);
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

  /** 仅 POST 需要解析 JSON 正文；run 与控制类接口使用各自的大小上限。 */
  private readonly parseBody = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const parser =
      this.routeOf(req) === WORKFLOW_EXECUTION_ROUTES.run ? this.runParser : this.controlParser;
    parser(req, res, next);
  };

  /** 将 parser 异常转换为不含原文片段的固定响应。 */
  private readonly handleParserError = (
    error: BodyParserError,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    if (error.type === 'entity.too.large' || error.status === 413) {
      this.reject(res, 413, WORKFLOW_EXECUTION_ERRORS.tooLarge.message);
    } else if (error.status === 415) {
      this.reject(res, 415, '请求内容类型或编码不受支持');
    } else if (error.status === undefined || error.status >= 500) {
      this.reject(res, 500, WORKFLOW_EXECUTION_ERRORS.internal.message);
    } else {
      this.reject(res, 400, '请求体不是有效的 JSON 对象');
    }
  };

  /**
   * 以不做隐式转换、禁止未知字段的方式校验 query 或 body。
   * 全局 ValidationPipe 会静默剔除未知字段并允许隐式转换，所以严格校验放在此处；失败只返回固定文案。
   */
  private readonly validateRequest = (req: Request, res: Response, next: NextFunction): void => {
    const dto = ROUTE_DTOS[this.routeOf(req)];
    const valid =
      req.method === 'POST'
        ? Object.keys(req.query).length === 0 && this.isStrictlyValid(dto, req.body)
        : this.isStrictlyValid(dto, { ...req.query });
    if (!valid) {
      this.reject(res, 400, WORKFLOW_EXECUTION_ERRORS.invalidRequest.message);
      return;
    }
    next();
  };

  private routeOf(req: Request): string {
    return ROUTE_PATTERN.exec(req.path)?.[1]?.toLowerCase() ?? '';
  }

  /** 把 token 头移入 WeakMap，并从 headers 与 rawHeaders 中抹去，避免被后续日志或中间件读取。 */
  private captureAccessToken(req: Request): void {
    const value = req.headers[WORKFLOW_EXECUTION_TOKEN_HEADER];
    if (value === undefined) return;
    this.tokens.set(req, Array.isArray(value) ? value.join(',') : value);
    delete req.headers[WORKFLOW_EXECUTION_TOKEN_HEADER];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index].toLowerCase() === WORKFLOW_EXECUTION_TOKEN_HEADER) {
        req.rawHeaders[index + 1] = '';
      }
    }
  }

  /**
   * Origin 的 scheme、host 与有效端口必须与当前请求的协议和 Host 完全一致；Sec-Fetch-Site 不能是跨站或同站。
   * 不信任 X-Forwarded-*；非浏览器客户端不带这两个头。
   */
  private isSameOrigin(req: Request): boolean {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (!req.headers.host) return false;
    try {
      const requested = new URL(origin);
      const expected = new URL(`${req.protocol}://${req.headers.host}`);
      // href 须等于 origin + '/'，拒绝带用户信息、路径或查询的非标准 Origin
      return requested.href === `${requested.origin}/` && requested.origin === expected.origin;
    } catch {
      return false;
    }
  }

  /** 必须是 JSON 对象，且字段类型严格、不含未知字段。 */
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
