// remote-call.decorator.ts
import 'reflect-metadata';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const CALL_METADATA_KEY = Symbol('REMOTE_CALL');

export interface RemoteCallOptions {
  /** 是否直接返回完整响应（含 headers/status），false 返回 response.data */
  res?: boolean;
  /** 请求超时时间（秒），0 表示不限时，不传则使用默认超时 */
  timeout?: number;
}

/**
 * 标记远程调用路径和方法。
 * 第三个参数支持对象形式，包含 res 和 timeout 配置。
 * 兼容旧签名：RemoteCall(path, method, true) 仍然可用。
 */
export function RemoteCall(
  path: string,
  method: HttpMethod,
  options?: RemoteCallOptions | boolean,
): MethodDecorator {
  // 兼容旧签名：第三个参数为 boolean 时当作 { res: boolean } 处理
  const resolvedOptions = typeof options === 'boolean' ? { res: options } : (options ?? {});

  return (target, propertyKey, descriptor) => {
    Reflect.defineMetadata(
      CALL_METADATA_KEY,
      {
        path,
        method,
        res: resolvedOptions.res ?? false,
        timeout: resolvedOptions.timeout,
      },
      descriptor.value!,
    );
  };
}

export function getRemoteCallMetadata<T>(target: T, methodName: string) {
  return Reflect.getMetadata(CALL_METADATA_KEY, target[methodName] as string) as {
    path: string;
    method: HttpMethod;
    res?: boolean;
    timeout?: number;
  };
}
