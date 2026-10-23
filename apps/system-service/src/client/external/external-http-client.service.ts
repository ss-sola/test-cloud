import { Injectable, Logger } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { inspect } from 'node:util';
import { WorkflowCapabilityException } from '../../modules/workflow-capabilities/workflow-capability.exception';

export interface ExternalHttpRequest {
  url: URL;
  method: 'GET' | 'POST' | 'PUT';
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}

export interface ExternalHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** 通过原生 fetch 请求配置地址，不预检域名或 IP，不额外设置默认时限。 */
@Injectable()
export class ExternalHttpClientService {
  private readonly logger = new Logger(ExternalHttpClientService.name);

  /** 读取有界响应；网络错误保留原始 Error，上游错误正文仅在后端脱敏打印。 */
  async request(options: ExternalHttpRequest): Promise<ExternalHttpResponse> {
    const signal =
      options.timeoutMs === undefined
        ? (options.signal ?? new AbortController().signal)
        : options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
          : AbortSignal.timeout(options.timeoutMs);
    if (signal.aborted) throw this.abortError(signal);
    const log = this.createLogRedactor(options);
    let response: Response | undefined;
    let loggedResponse = false;
    try {
      const received = await this.waitFor<Response>(
        Promise.resolve().then(async () => {
          if (signal.aborted) throw this.abortError(signal);
          const incoming = await fetch(options.url, {
            method: options.method,
            headers: options.headers,
            body: options.body,
            signal,
            redirect: 'manual',
          });
          if (signal.aborted) {
            void incoming.body?.cancel().catch(() => undefined);
            throw this.abortError(signal);
          }
          return incoming;
        }),
        signal,
      );
      response = received;
      const body = await this.readResponse(received, options.maxResponseBytes, signal);
      if (!received.ok) {
        this.logger.error(
          `${options.method} ${log.target}\nHTTP ${received.status} ${log.text(received.statusText)}`,
        );
        this.logger.error(log.body(body));
        loggedResponse = true;
      }
      if (received.status >= 300 && received.status < 400) {
        throw new WorkflowCapabilityException('外部服务返回了重定向，已拒绝跟随。', 502);
      }
      return { status: received.status, headers: Object.fromEntries(received.headers), body };
    } catch (error) {
      if (signal.aborted) throw this.abortError(signal);
      if (!loggedResponse) {
        this.logger.error(
          `${options.method} ${log.target}${response ? `\nHTTP ${response.status} ${log.text(response.statusText)}` : ''}`,
        );
        this.logger.error(
          log.text(inspect(error, { depth: null, colors: false, maxStringLength: null })),
        );
      }
      throw error;
    }
  }

  /** 响应按 fetch 解压后的字节流计量；清理不能阻塞取消或替换原始读取错误。 */
  private async readResponse(
    response: Response,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<string> {
    const encoding = response.headers.get('content-encoding');
    if (
      (!encoding || encoding === 'identity') &&
      Number(response.headers.get('content-length') ?? 0) > maxBytes
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new WorkflowCapabilityException('外部服务响应超过大小预算。', 502);
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let complete = false;
    try {
      while (true) {
        const item = await this.waitFor(reader.read(), signal);
        if (item.done) {
          complete = true;
          break;
        }
        received += item.value.byteLength;
        if (received > maxBytes)
          throw new WorkflowCapabilityException('外部服务响应超过大小预算。', 502);
        chunks.push(item.value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      if (complete) reader.releaseLock();
      else
        void reader
          .cancel()
          .then(() => reader.releaseLock())
          .catch(() => undefined);
    }
  }

  /** 即使替身 fetch 或流读取未响应 signal，也立即结束等待且不接收迟到结果。 */
  private waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(this.abortError(signal));
      };
      operation.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** 只替换凭据与回显请求字段，保留原始错误文本、堆栈和上游错误内容。 */
  private createLogRedactor(options: ExternalHttpRequest) {
    const sensitive = /token|secret|password|api[-_]?key|authorization|cookie/i;
    const secrets = new Set<string>();
    const remember = (value: unknown) => {
      if (typeof value === 'string' && value) secrets.add(value);
    };
    for (const [key, value] of Object.entries(options.headers)) {
      if (!sensitive.test(key)) continue;
      remember(value);
      remember(value.match(/^(?:Bearer|Basic)\s+(.+)$/i)?.[1]);
    }
    for (const value of [options.url.username, options.url.password]) {
      remember(value);
      try {
        remember(decodeURIComponent(value));
      } catch {
        /* 非法转义保留原文本用于脱敏 */
      }
    }
    for (const [key, value] of options.url.searchParams) if (sensitive.test(key)) remember(value);
    const collect = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (sensitive.test(key)) remember(item);
        else collect(item);
      }
    };
    try {
      collect(JSON.parse(options.body ?? 'null'));
    } catch {
      /* 非 JSON 请求不进入日志 */
    }
    const replacements = [...secrets].sort((left, right) => right.length - left.length);
    const replaceSecrets = (value: string) => {
      let result = value;
      for (const secret of replacements) result = result.replaceAll(secret, '[REDACTED]');
      return result;
    };
    const text = (value: string) =>
      replaceSecrets(value)
        .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
        .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]');
    const sanitize = (value: unknown): unknown => {
      if (typeof value === 'string') return text(value);
      if (Array.isArray(value)) return value.map(sanitize);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            sensitive.test(key) ||
            /^(?:prompt|messages|input|values|headers|request|requestBody|request_body)$/i.test(key)
              ? '[REDACTED]'
              : sanitize(item),
          ]),
        );
      }
      return value;
    };
    const body = (value: string) => {
      try {
        return JSON.stringify(sanitize(JSON.parse(value)), null, 2);
      } catch {
        return text(value);
      }
    };
    const target = new URL(options.url);
    target.username = '';
    target.password = '';
    target.hash = '';
    for (const key of target.searchParams.keys()) target.searchParams.set(key, '[REDACTED]');
    return { target: replaceSecrets(target.href), text, body };
  }

  /** 显式超时或调用方停止属于生命周期控制，不替换真实网络错误。 */
  private abortError(signal: AbortSignal): WorkflowCapabilityException {
    const reason: unknown = signal.reason;
    return reason instanceof Error && reason.name === 'TimeoutError'
      ? new WorkflowCapabilityException('外部服务请求超时。', 504)
      : new WorkflowCapabilityException('请求已取消。', 499);
  }
}
