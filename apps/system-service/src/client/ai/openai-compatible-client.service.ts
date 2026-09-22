import { Injectable } from '@nestjs/common';
import type { OpenAiCompatibleFetch, OpenAiCompatibleRequest } from './ai.types';

/** 调用 OpenAI-compatible Chat Completions，并统一处理超时、响应上限和异常降级。 */
@Injectable()
export class OpenAiCompatibleClientService {
  async request(
    options: OpenAiCompatibleRequest,
    fetchImpl?: OpenAiCompatibleFetch,
  ): Promise<string | undefined> {
    const { ai, prompt } = options;
    const fail = (reason: string): undefined => {
      options.onFailure?.(reason);
      return undefined;
    };
    if (!ai.baseUrl || !ai.apiKey || !ai.model)
      return fail('AI 配置不完整，需要 baseUrl、apiKey 和 model。');
    if (prompt.length > options.maxPromptCharacters) {
      return fail(`AI prompt 超过长度限制（${options.maxPromptCharacters} 字符）。`);
    }

    const baseUrl = this.parseBaseUrl(ai.baseUrl);
    if (!baseUrl) return fail('AI baseUrl 无效，必须是无凭据、无查询参数的 HTTP(S) 地址。');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const fetcher = fetchImpl ?? (globalThis.fetch.bind(globalThis) as OpenAiCompatibleFetch);
    try {
      const response = await fetcher(`${baseUrl.toString().replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ai.apiKey}`,
        },
        body: JSON.stringify({
          model: ai.model,
          temperature: options.temperature ?? 0.2,
          messages: [
            { role: 'system', content: options.systemMessage },
            { role: 'user', content: prompt },
          ],
        }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) return fail(`AI HTTP 请求失败（HTTP ${response.status}）。`);
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > options.maxResponseCharacters) {
        return fail(`AI 响应超过长度限制（${options.maxResponseCharacters} 字符）。`);
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > options.maxResponseCharacters) {
        return fail(`AI 响应超过长度限制（${options.maxResponseCharacters} 字符）。`);
      }
      let payload: { choices?: Array<{ message?: { content?: string } }> };
      try {
        payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
      } catch {
        return fail('AI 响应不是有效 JSON。');
      }
      const content = payload.choices?.[0]?.message?.content?.trim();
      return content ? content : fail('AI 响应缺少 choices[0].message.content。');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return fail(`AI 请求超时（${options.timeoutMs}ms）。`);
      }
      return fail('AI 请求异常，请检查网络、baseUrl 和服务端可用性。');
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseBaseUrl(value: string): URL | undefined {
    try {
      const url = new URL(value.trim());
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        return undefined;
      }
      return url;
    } catch {
      return undefined;
    }
  }
}
