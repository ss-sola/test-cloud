import { Injectable } from '@nestjs/common';
import { getConfig, ProjectException } from '@nest-cloud/common';
import {
  DEFAULT_FEISHU_MAX_RETRIES,
  DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
  FEISHU_OPEN_API_BASE_URL,
  FEISHU_RETRY_BASE_DELAY_MS,
  WeeklyReportConfigKeys,
} from '../../modules/weekly-commit-report/weekly-report.constants';
import type { FeishuApiResponse } from './feishu.types';

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
  async request<T>(options: FeishuRequestOptions): Promise<T> {
    const timeoutMs = this.getPositiveConfig(
      WeeklyReportConfigKeys.FeishuRequestTimeoutMs,
      DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
    );
    const maxRetries = this.getNonNegativeConfig(
      WeeklyReportConfigKeys.FeishuMaxRetries,
      DEFAULT_FEISHU_MAX_RETRIES,
    );
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
        throw new FeishuApiException(
          `飞书 API 调用失败（HTTP ${response.status}）。`,
          response.status,
          response.status === 429 || response.status >= 500,
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

  private getPositiveConfig(key: string, fallback: number): number {
    const value = getConfig<number>(key, fallback, false);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private getNonNegativeConfig(key: string, fallback: number): number {
    const value = getConfig<number>(key, fallback, false);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private delay(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }
}
