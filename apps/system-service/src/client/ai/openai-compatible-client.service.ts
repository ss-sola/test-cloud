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
    if (!ai.baseUrl || !ai.apiKey || !ai.model || prompt.length > options.maxPromptCharacters) {
      return undefined;
    }

    const baseUrl = this.parseBaseUrl(ai.baseUrl);
    if (!baseUrl) return undefined;

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
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (!response.ok || contentLength > options.maxResponseCharacters) return undefined;
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > options.maxResponseCharacters) return undefined;
      const payload = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content?.trim();
      return content || undefined;
    } catch {
      return undefined;
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
