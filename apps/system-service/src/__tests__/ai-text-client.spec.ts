import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import axios, { CanceledError, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiTextClientService, type AiTextRequest } from '../client/ai/ai-text-client.service';
import { AiTextClientException } from '../client/ai/ai-text-client.exception';
import { OpenAiCompatibleChatModel } from '../client/ai/openai-compatible-chat-model';

const SECRET = 'test-api-key-private';
const request: AiTextRequest = {
  baseUrl: 'https://model.example/v1',
  apiKey: SECRET,
  model: 'explicit-model',
  prompt: '用户原文',
  systemPrompt: '保留原文格式',
};

function completion(content: unknown = '生成内容', finishReason: unknown = 'stop'): string {
  return JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] });
}

function reply(data = completion(), status = 200): AxiosResponse<string> {
  return { data, status, statusText: '', headers: {}, config: {} } as AxiosResponse<string>;
}

function setup(data = completion(), status = 200) {
  const transport = vi.spyOn(axios, 'request').mockResolvedValue(reply(data, status));
  return { transport, client: new AiTextClientService() };
}

async function localModel(run: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(run);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('模型禁止使用 fetch')));
});

afterEach(() => {
  const usedFetch = vi.mocked(globalThis.fetch).mock.calls.length > 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  if (usedFetch) throw new Error('模型调用不应使用 fetch。');
});

describe('LangChain AI text client', () => {
  it('uses a real BaseChatModel invoke and Node HTTP with explicit per-request messages and credentials', async () => {
    const invoke = vi.spyOn(OpenAiCompatibleChatModel.prototype, 'invoke');
    const { transport, client } = setup(completion('  保留首尾空白\n'));
    await expect(client.generate(request)).resolves.toBe('  保留首尾空白\n');
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.instances[0]).toBeInstanceOf(BaseChatModel);
    const [messages, options] = invoke.mock.calls[0];
    expect(messages).toMatchObject([
      { type: 'system', content: request.systemPrompt },
      { type: 'human', content: request.prompt },
    ]);
    expect(options).toMatchObject({
      callbacks: [],
      maxRetries: 0,
      signal: expect.any(AbortSignal),
    });
    const call = transport.mock.calls[0][0];
    expect(call).toMatchObject({
      adapter: 'http',
      proxy: false,
      url: 'https://model.example/v1/chat/completions',
      timeout: 0,
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      data: {
        model: request.model,
        stream: false,
        enable_thinking: false,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.prompt },
        ],
      },
    });
    expect(call.data).not.toHaveProperty('temperature');
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens'])
      expect(call.data).not.toHaveProperty(key);
    expect(
      JSON.stringify((invoke.mock.instances[0] as OpenAiCompatibleChatModel).toJSON()),
    ).not.toContain(SECRET);
  });

  it('preserves caller temperature and omits blank system prompts', async () => {
    const { transport, client } = setup();
    await client.generate({ ...request, systemPrompt: ' \n ', temperature: 0.2 });
    expect(transport.mock.calls[0][0].data).toEqual({
      model: request.model,
      stream: false,
      enable_thinking: false,
      temperature: 0.2,
      messages: [{ role: 'user', content: request.prompt }],
    });
  });

  it.each([undefined, false, true])(
    'sends enable_thinking=%s with a default of false',
    async (enableThinking) => {
      const { transport, client } = setup();
      await client.generate({ ...request, enableThinking });
      expect(transport.mock.calls[0][0].data).toMatchObject({
        enable_thinking: enableThinking ?? false,
      });
      expect(transport.mock.calls[0][0].data).not.toHaveProperty('enableThinking');
    },
  );

  it('does not cache models or reuse credentials between executions', async () => {
    const { transport, client } = setup();
    await client.generate(request);
    await client.generate({
      ...request,
      model: 'other-model',
      apiKey: 'other-key',
      baseUrl: 'http://intranet:8080/api/',
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][0]).toMatchObject({
      url: 'http://intranet:8080/api/chat/completions',
      headers: { Authorization: 'Bearer other-key' },
      data: { model: 'other-model' },
    });
  });

  it.each(['baseUrl', 'apiKey', 'model'] as const)(
    'rejects blank %s before invoking the model',
    async (field) => {
      const { transport, client } = setup();
      await expect(client.generate({ ...request, [field]: ' \t ' })).rejects.toMatchObject({
        status: 400,
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each(['not a url', 'ftp://model.example/v1'])(
    'rejects invalid endpoint %s safely',
    async (baseUrl) => {
      const { transport, client } = setup();
      await expect(client.generate({ ...request, baseUrl })).rejects.toBeInstanceOf(
        AiTextClientException,
      );
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('rejects empty and over-budget input before any transport', async () => {
    const { transport, client } = setup();
    await expect(client.generate({ ...request, prompt: ' \n ' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.generate({ ...request, maxPromptCharacters: 1 })).rejects.toMatchObject({
      status: 422,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    'not JSON',
    'null',
    '{}',
    completion(' \n '),
    completion(123),
    completion(['not text']),
  ])('rejects invalid completion %s without a local fallback', async (data) => {
    const { client } = setup(data);
    await expect(client.generate(request)).rejects.toMatchObject({ status: 502 });
  });

  it.each(['length', 'tool_calls', 'content_filter', null, 1, undefined])(
    'requires exact stop completion, rejecting %s',
    async (finishReason) => {
      const data = JSON.stringify({
        choices: [{ finish_reason: finishReason, message: { content: 'partial' } }],
      });
      const { client } = setup(data);
      await expect(client.generate(request)).rejects.toMatchObject({ status: 422 });
    },
  );

  it('enforces actual UTF-8 response bytes and the text character budget', async () => {
    const { client } = setup(completion('中'.repeat(100)));
    await expect(client.generate({ ...request, maxResponseBytes: 200 })).rejects.toMatchObject({
      status: 422,
    });
    await expect(client.generate({ ...request, maxOutputCharacters: 50 })).rejects.toMatchObject({
      status: 422,
    });
  });

  it('reports HTTP status without provider body, credentials or prompt', async () => {
    const { transport, client } = setup(
      JSON.stringify({ error: `${SECRET} ${request.prompt}` }),
      401,
    );
    await expect(client.generate(request)).rejects.toMatchObject({
      status: 502,
      message: 'AI 服务请求失败（HTTP 401）。',
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not retry network failures or expose raw errors', async () => {
    const { transport, client } = setup();
    transport.mockRejectedValue(new Error(`network ${SECRET} ${request.prompt}`));
    await expect(client.generate(request)).rejects.toMatchObject({
      status: 502,
      message: 'AI 请求异常，请检查网络、baseUrl 和服务端可用性。',
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('has no implicit model deadline after ten minutes', async () => {
    vi.useFakeTimers();
    let release!: (value: AxiosResponse<string>) => void;
    const transport = vi.spyOn(axios, 'request').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const pending = new AiTextClientService().generate(request).then((text) => {
      settled = true;
      return text;
    });
    await vi.advanceTimersByTimeAsync(600_001);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0].timeout).toBe(0);
    expect(settled).toBe(false);
    release(reply());
    await expect(pending).resolves.toBe('生成内容');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps explicit weekly-report deadlines and aborts the model request', async () => {
    const transport = vi.spyOn(axios, 'request').mockImplementation(
      (options: AxiosRequestConfig) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener!('abort', () => reject(new CanceledError()));
        }),
    );
    await expect(
      new AiTextClientService().generate({ ...request, timeoutMs: 5 }),
    ).rejects.toMatchObject({ status: 504, message: 'AI 请求超时（5ms）。' });
    expect(transport.mock.calls[0][0].signal?.aborted).toBe(true);
  });

  it('rejects pre-cancelled calls without transport', async () => {
    const { transport, client } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(client.generate({ ...request, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('follows caller cancellation and sends no replacement call', async () => {
    const controller = new AbortController();
    const transport = vi.spyOn(axios, 'request').mockImplementation(
      (options: AxiosRequestConfig) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener!('abort', () => reject(new CanceledError()));
          queueMicrotask(() => controller.abort());
        }),
    );
    await expect(
      new AiTextClientService().generate({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('disables standard LangSmith tracing even if environment tracing is enabled', async () => {
    vi.stubEnv('LANGSMITH_TRACING', 'true');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'true');
    vi.stubEnv('LANGSMITH_API_KEY', 'not-a-real-key');
    vi.stubEnv('LANGSMITH_ENDPOINT', 'http://127.0.0.1:9');
    const { transport, client } = setup();
    await expect(client.generate(request)).resolves.toBe('生成内容');
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe('LangChain client with local Node HTTP model', () => {
  it('uses only HTTP adapter, preserves query, ignores fragment and never switches to Responses API', async () => {
    let path = '',
      body = '',
      authorization: string | undefined;
    const model = await localModel((req, res) => {
      path = req.url!;
      authorization = req.headers.authorization;
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(completion('wire result'));
      });
    });
    try {
      const text = await new AiTextClientService().generate({
        ...request,
        baseUrl: `${model.baseUrl}/?tenant=test#ignored`,
        model: 'gpt-5.4-pro',
      });
      expect(text).toBe('wire result');
      expect(path).toBe('/v1/chat/completions?tenant=test');
      expect(authorization).toBe(`Bearer ${SECRET}`);
      expect(JSON.parse(body)).toEqual({
        model: 'gpt-5.4-pro',
        stream: false,
        enable_thinking: false,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.prompt },
        ],
      });
    } finally {
      await model.close();
    }
  });

  it('never follows provider redirects', async () => {
    const paths: string[] = [];
    const model = await localModel((req, res) => {
      paths.push(req.url!);
      res.writeHead(302, { Location: '/redirect-target' });
      res.end();
    });
    try {
      await expect(
        new AiTextClientService().generate({ ...request, baseUrl: model.baseUrl }),
      ).rejects.toMatchObject({ status: 502, message: 'AI 服务请求失败（HTTP 302）。' });
      expect(paths).toEqual(['/v1/chat/completions']);
    } finally {
      await model.close();
    }
  });

  it('aborts oversized decompressed responses instead of accepting a small compressed body', async () => {
    const compressed = gzipSync(Buffer.from(completion('字'.repeat(5_000))));
    expect(compressed.length).toBeLessThan(1024);
    const model = await localModel((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(compressed);
    });
    try {
      await expect(
        new AiTextClientService().generate({
          ...request,
          baseUrl: model.baseUrl,
          maxResponseBytes: 1024,
        }),
      ).rejects.toMatchObject({ status: 422, message: 'AI 响应超过长度预算。' });
    } finally {
      await model.close();
    }
  });
});
