import { Injectable } from '@nestjs/common';
import { ProjectException } from '@nest-cloud/common';
import {
  FEISHU_OPEN_API_BASE_URL,
  FEISHU_RETRY_BASE_DELAY_MS,
} from '../../modules/weekly-commit-report/weekly-report.constants';
import type { FeishuApiResponse, FeishuRequestContext } from './feishu.types';

interface FeishuRequestOptions {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  accessToken?: string;
  query?: Record<string, string>;
  body?: unknown;
}

export class FeishuApiException extends ProjectException {
  readonly retryable: boolean;
  readonly apiCode?: number;

  constructor(message: string, status: number, retryable: boolean, apiCode?: number) {
    super(message, status);
    this.retryable = retryable;
    this.apiCode = apiCode;
  }
}

@Injectable()
export class FeishuHttpClientService {
  async request<T>(options: FeishuRequestOptions, context: FeishuRequestContext): Promise<T> {
    const timeoutMs = context.requestTimeoutMs;
    const maxRetries = context.maxRetries;
    const url = this.buildUrl(options.path, options.query);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<T>(options, url, timeoutMs);
      } catch (error) {
        const apiError = this.toApiException(error);
        if (!apiError.retryable || attempt >= maxRetries) throw apiError;
        await this.delay(FEISHU_RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }

  private async requestOnce<T>(
    options: FeishuRequestOptions,
    url: string,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = this.parseResponse(text);
      if (!response.ok) {
        const detail = this.getResponseErrorDetail(payload);
        const operation = this.getOperationLabel(options.path);
        throw new FeishuApiException(
          `飞书 API 调用失败（${operation}，HTTP ${response.status}${detail ? `：${detail}` : ''}）。`,
          response.status,
          response.status === 429 || response.status >= 500,
          this.getResponseErrorCode(payload),
        );
      }
      if (this.isApiError(payload)) {
        throw new FeishuApiException(
          `飞书 API 调用失败：${payload.msg || '未知错误'}。`,
          502,
          false,
          payload.code,
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof FeishuApiException) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new FeishuApiException('飞书 API 请求超时。', 504, true);
      }
      throw new FeishuApiException(
        `飞书 API 请求异常：${error instanceof Error ? error.message : String(error)}。`,
        502,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResponse(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new FeishuApiException('飞书 API 返回了无法解析的响应。', 502, false);
    }
  }

  private getOperationLabel(path: string): string {
    if (path.includes('/auth/')) return '获取访问令牌';
    if (path.includes('/wiki/')) return '解析 Wiki 节点';
    if (path.includes('/sheets/v3/')) return '读取 Sheet 列表';
    if (path.includes('/sheets/v2/') && path.endsWith('/values')) return '写入 Sheet';
    if (path.includes('/sheets/v2/')) return '读取 Sheet 内容';
    return '请求飞书接口';
  }

  private getResponseErrorDetail(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';
    const message = (payload as { msg?: unknown }).msg;
    if (typeof message !== 'string') return '';
    return message
      .replace(
        /(app[_-]?secret|secret|token|authorization|password)\s*[:=]\s*[^\s,;]+/gi,
        '$1=[REDACTED]',
      )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 256);
  }

  private getResponseErrorCode(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const code = (payload as { code?: unknown }).code;
    return typeof code === 'number' && code !== 0 ? code : undefined;
  }

  private isApiError(payload: unknown): payload is FeishuApiResponse {
    return (
      !!payload &&
      typeof payload === 'object' &&
      'code' in payload &&
      typeof (payload as { code?: unknown }).code === 'number' &&
      (payload as { code: number }).code !== 0
    );
  }

  private toApiException(error: unknown): FeishuApiException {
    if (error instanceof FeishuApiException) return error;
    return new FeishuApiException(
      `飞书 API 请求异常：${error instanceof Error ? error.message : String(error)}。`,
      502,
      true,
    );
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`${FEISHU_OPEN_API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private delay(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }
}
