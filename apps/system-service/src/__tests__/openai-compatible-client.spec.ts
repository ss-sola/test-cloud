import { describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleClientService } from '../client/ai/openai-compatible-client.service';
import type { OpenAiCompatibleFetch } from '../client/ai/ai.types';

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('OpenAI-compatible client', () => {
  it('sends bearer credentials and returns the first completion', async () => {
    const fetchImpl = vi
      .fn<OpenAiCompatibleFetch>()
      .mockResolvedValue(
        response(200, JSON.stringify({ choices: [{ message: { content: '1. 摘要' } }] })),
      );
    const client = new OpenAiCompatibleClientService();

    await expect(
      client.request(
        {
          ai: { baseUrl: 'https://ai.example.com/v1', apiKey: 'secret', model: 'release-model' },
          prompt: 'facts',
          systemMessage: 'json only',
          timeoutMs: 100,
          maxPromptCharacters: 1000,
          maxResponseCharacters: 10_000,
        },
        fetchImpl,
      ),
    ).resolves.toBe('1. 摘要');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ai.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
        body: expect.stringContaining('release-model'),
      }),
    );
  });

  it('returns undefined for invalid responses without exposing provider details', async () => {
    const fetchImpl = vi
      .fn<OpenAiCompatibleFetch>()
      .mockResolvedValue(response(502, 'secret error'));
    const client = new OpenAiCompatibleClientService();

    await expect(
      client.request(
        {
          ai: { baseUrl: 'https://ai.example.com/v1', apiKey: 'secret', model: 'model' },
          prompt: 'facts',
          systemMessage: 'json only',
          timeoutMs: 100,
          maxPromptCharacters: 1000,
          maxResponseCharacters: 10_000,
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
  });

  it('reports a safe reason for provider failures without exposing response content', async () => {
    const fetchImpl = vi
      .fn<OpenAiCompatibleFetch>()
      .mockResolvedValue(response(401, 'secret error'));
    const failures: string[] = [];
    const client = new OpenAiCompatibleClientService();

    await expect(
      client.request(
        {
          ai: { baseUrl: 'https://ai.example.com/v1', apiKey: 'secret', model: 'model' },
          prompt: 'facts',
          systemMessage: 'json only',
          timeoutMs: 100,
          maxPromptCharacters: 1000,
          maxResponseCharacters: 10_000,
          onFailure: (reason) => failures.push(reason),
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
    expect(failures).toEqual(['AI HTTP 请求失败（HTTP 401）。']);
  });

  it('rejects URLs with credentials or query parameters', async () => {
    const fetchImpl = vi.fn<OpenAiCompatibleFetch>();
    const client = new OpenAiCompatibleClientService();

    await expect(
      client.request(
        {
          ai: {
            baseUrl: 'https://user:pass@ai.example.com/v1?token=x',
            apiKey: 'secret',
            model: 'model',
          },
          prompt: 'facts',
          systemMessage: 'json only',
          timeoutMs: 100,
          maxPromptCharacters: 1000,
          maxResponseCharacters: 10_000,
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
