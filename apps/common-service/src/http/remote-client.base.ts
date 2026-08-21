// axios-client.base.ts
import axios from 'axios';
import { getRemoteCallMetadata } from './remote-call.decorator';
import { getRemoteServiceMeta, LB_Type } from './remote-service.decorator';
import { ContextService } from '../context/context.service';
import { ProjectException, RemoteException } from '@/exception/global.exception';
import { DEFAULT_REMOTE_TIMEOUT } from '@/constants/http.constants';
import { RegistryClientService } from '@/client/registry-client.service';
import { LoadBalanceStrategy } from './strategy/lb.strategy';
import { RandomStrategy } from './strategy/lb.random';
import { RoundRobinStrategy } from './strategy/lb.round-robin';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { getConfig } from '@/config-center';
import { ConfigKeys } from '@/config/keys';
import { AxiosError, Method } from 'axios';
import { ResponseUtil } from '@/util/response.util';

const logger = new Logger('RemoteClientBase');

@Injectable()
export class RemoteClientBase {
  self: this;
  private lbStrategy!: LoadBalanceStrategy;

  @Optional()
  @Inject(RegistryClientService)
  private readonly registryClient?: RegistryClientService;

  constructor() {
    this.self = this._initProxy(this);
  }
  _initProxy<T extends object>(instance: T): T {
    const { name, url: fixedUrl, lb, res } = getRemoteServiceMeta(instance);
    this.lbStrategy = initLbalanceStrategy(lb);
    if (!name && !fixedUrl) throw new ProjectException(`@RemoteService 必须指定 name 或 url`);

    return new Proxy(instance, {
      get: (target, prop: string) => {
        const metadata = getRemoteCallMetadata<T>(target, prop);
        if (!metadata) throw new ProjectException('装饰器异常');

        return async (...args: any[]) => {
          const { path, method } = metadata;

          const { finalPath, queryString, remainingData } = formatPathWithParams(
            path,
            args,
            method,
          );

          const nodeEnv = getConfig<string>(ConfigKeys.NodeEnv, '', false);
          const isProd = nodeEnv === 'production';
          let baseUrl = !isProd && fixedUrl ? fixedUrl : this.getServiceUrl(name!);
          if (path.startsWith('http://') || path.startsWith('https://')) {
            baseUrl = '';
          }
          const url = `${baseUrl}${finalPath}${queryString ?? ''}`;

          const req = ContextService.getReq();
          const headers = filterForwardHeaders(req?.headers ?? {}) as Record<
            string,
            string | string[]
          >;

          // 计算超时：装饰器指定 > 默认超时 > 不超时
          let axiosTimeout: number | undefined = DEFAULT_REMOTE_TIMEOUT;
          if (metadata.timeout === 0) {
            // 0 表示不限时
            axiosTimeout = undefined;
          } else if (metadata.timeout != null && metadata.timeout > 0) {
            // 装饰器指定超时（秒 → 毫秒）
            axiosTimeout = metadata.timeout * 1000;
          }

          try {
            const response = await axios.request({
              url,
              method,
              data: remainingData,
              headers,
              timeout: axiosTimeout,
            });

            return res ? response : response.data;
          } catch (error: unknown) {
            if (axios.isAxiosError(error)) {
              handleAxiosError(error, method, url);
            }

            throw new RemoteException(
              `远程调用异常 [${method.toUpperCase()} ${url}] - ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };
      },
    });
  }
  getServiceUrl(serviceName: string): string {
    if (!this.registryClient)
      throw new ProjectException(`未配置服务注册客户端，无法使用服务发现功能`);
    const instances = this.registryClient.getInstances(serviceName);

    if (!instances || instances.length === 0) {
      throw new RemoteException(`未发现可用的服务实例: ${serviceName}`);
    }

    const instance = this.lbStrategy.select(instances, serviceName);
    if (!instance) {
      throw new RemoteException(`负载均衡未选到实例: ${serviceName}`);
    }

    return `http://${instance.host}:${instance.port}`;
  }
  async safeCall<T>(
    remoteCall: Promise<ResponseUtil<T>>,
    schema: z.ZodType<T>,
  ): Promise<ResponseUtil<T>> {
    const res = await remoteCall;
    res.data = validateResponse(res.data, schema);
    return res;
  }
}
function validateResponse<T>(data: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    logger.error(`响应结构不符合预期: ${JSON.stringify(result.error.format())}`);
    throw new RemoteException('响应结构校验失败');
  }
  return result.data;
}
export function formatPathWithParams(
  path: string,
  args: any[],
  method: string,
): {
  finalPath: string;
  queryString?: string;
  remainingData?: any;
} {
  const paramMatches = Array.from(path.matchAll(/:([a-zA-Z0-9_]+)/g));
  const paramKeys = paramMatches.map((m) => m[1]);

  let finalPath = path;
  let queryString = '';
  let remainingData: any = undefined;

  const isSingleObjectArg = args.length === 1 && typeof args[0] === 'object' && args[0] !== null;

  if (isSingleObjectArg) {
    const rawArg = args[0] as Record<string, string>;
    const usedKeys = new Set<string>();
    const query: Record<string, string> = {};
    const body: Record<string, any> = {};

    // 替换路径参数
    for (const key of paramKeys) {
      if (!(key in rawArg)) {
        throw new Error(`Missing value for path parameter ':${key}'`);
      }
      finalPath = finalPath.replace(`:${key}`, encodeURIComponent(rawArg[key]));
      usedKeys.add(key);
    }

    // 处理剩余字段
    for (const [k, v] of Object.entries(rawArg)) {
      if (!usedKeys.has(k)) {
        if (method.toUpperCase() === 'GET') {
          query[k] = String(v);
        } else {
          body[k] = v;
        }
      }
    }

    if (Object.keys(query).length > 0) {
      queryString = '?' + new URLSearchParams(query).toString();
    }
    if (Object.keys(body).length > 0) {
      remainingData = body;
    }
  } else {
    // 非对象参数，按顺序替换
    if (args.length < paramKeys.length) {
      throw new Error(`Expected at least ${paramKeys.length} arguments`);
    }

    paramKeys.forEach((key, index) => {
      finalPath = finalPath.replace(`:${key}`, encodeURIComponent(args[index] as string));
    });
  }

  return {
    finalPath,
    queryString,
    remainingData,
  };
}

/** 转发请求时需剔除的 header（与入站请求绑定，不适用于出站请求） */
const HEADERS_TO_STRIP = [
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
];

function filterForwardHeaders(allHeaders: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(allHeaders)) {
    if (!HEADERS_TO_STRIP.includes(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered as Record<string, string | string[]>;
}

function initLbalanceStrategy(lb?: LB_Type) {
  switch (lb) {
    case LB_Type.RANDOM:
      return new RandomStrategy();
    case LB_Type.ROUND_ROBIN:
      return new RoundRobinStrategy();
    default:
      return new RandomStrategy();
  }
}

export function handleAxiosError(error: AxiosError, method: Method, url: string): never {
  if (error.response) {
    // 服务端返回错误响应 (4xx/5xx)
    throw new RemoteException(
      `远程调用失败 [${method.toUpperCase()} ${url}] - ` +
        `状态码: ${error.response.status}, ` +
        `响应: ${JSON.stringify(error.response.data)}`,
    );
  } else if (error.code === 'ECONNABORTED') {
    // 请求超时
    throw new RemoteException(
      `远程调用超时 [${method.toUpperCase()} ${url}] - ` +
        `请求超过 ${error.config?.timeout ?? '未知'}ms 未收到响应`,
    );
  } else if (error.request) {
    // 请求已发出但没有收到响应
    throw new RemoteException(
      `远程调用无响应 [${method.toUpperCase()} ${url}] - ` +
        `请求已发送但未收到响应，可能是网络问题或服务不可达`,
    );
  } else {
    // 其它错误（配置错误、序列化错误等）
    throw new RemoteException(`远程调用异常 [${method.toUpperCase()} ${url}] - ${error.message}`);
  }
}
