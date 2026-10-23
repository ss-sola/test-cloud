import { ProjectException } from '@nest-cloud/common';
import axios, { AxiosError, CanceledError, type AxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiTextClientException } from '../client/ai/ai-text-client.exception';
import { AiTextClientService } from '../client/ai/ai-text-client.service';
import { AI_MODEL_LIMITS } from '../constants/ai-model.constants';
import { AiTextCapabilityService } from '../modules/workflow-capabilities/ai-text-capability.service';
import type { AiTextDto } from '../modules/workflow-capabilities/dto/ai-text.dto';
import { WorkflowCapabilityException } from '../modules/workflow-capabilities/workflow-capability.exception';

const API_KEY = 'sk-SECRET_KEY_9f3a7c';

interface StubResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}
type Responder =
  | StubResponse
  | ((config: AxiosRequestConfig, index: number) => StubResponse | Promise<StubResponse>);

function completion(content: unknown, finishReason: unknown = 'stop'): StubResponse {
  return {
    status: 200,
    headers: {},
    data: JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }),
  };
}

/** 替换 axios.request 为可控响应，保留真实的 LangChain invoke 到模型适配器链路。 */
function stubAxios(responder: Responder) {
  const request = vi.spyOn(axios, 'request').mockImplementation((async (
    config: AxiosRequestConfig,
  ) => {
    const index = request.mock.calls.length - 1;
    const response = typeof responder === 'function' ? await responder(config, index) : responder;
    return { statusText: '', config, ...response };
  }) as unknown as typeof axios.request);
  return request;
}

function setup(responder: Responder) {
  const request = stubAxios(responder);
  const service = new AiTextCapabilityService(new AiTextClientService());
  return { request, service };
}

/** 读取第 index 次 axios 调用的配置。 */
const configOf = (request: { mock: { calls: unknown[][] } }, index = 0) =>
  request.mock.calls[index][0] as AxiosRequestConfig;
const bodyOf = (config: AxiosRequestConfig) =>
  config.data as {
    model: string;
    stream: boolean;
    messages: Array<{ role: string; content: unknown }>;
  };

/** 模拟 axios 对 AbortSignal 的响应：信号取消时以 CanceledError 拒绝，否则保持挂起。 */
function hangUntilAborted(config: AxiosRequestConfig, onStart?: () => void): Promise<never> {
  onStart?.();
  return new Promise<never>((_resolve, reject) => {
    (config.signal as AbortSignal | undefined)?.addEventListener(
      'abort',
      () => reject(new CanceledError('canceled')),
      { once: true },
    );
  });
}

function dto(
  overrides: Partial<AiTextDto> = {},
  baseUrl = 'https://api.example.com/v1',
): AiTextDto {
  return {
    prompt: '请总结',
    runtime: { ai: { baseUrl, apiKey: API_KEY, model: 'gpt-test' } },
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

async function failure<T extends ProjectException>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => T = AiTextClientException as unknown as new (
    ...args: never[]
  ) => T,
): Promise<T> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(type);
  return error as T;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AiTextCapabilityService', () => {
  it('posts a non-streaming chat completion through the Axios model adapter and returns only the text', async () => {
    const { request, service } = setup(completion('生成的文本'));

    const result = await service.generate(dto({ systemPrompt: '你是助手' }), signal());

    expect(result).toEqual({ text: '生成的文本' });
    expect(request).toHaveBeenCalledOnce();
    const config = configOf(request);
    expect(config.url).toBe('https://api.example.com/v1/chat/completions');
    expect(config.method).toBe('POST');
    expect(config.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'nestcloud-ai-client',
    });
    expect(config.data).toEqual({
      model: 'gpt-test',
      stream: false,
      enable_thinking: false,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '请总结' },
      ],
    });
    expect(JSON.stringify(config.data)).not.toContain(API_KEY);
  });

  it.each([false, true])(
    'passes runtime.ai.enableThinking=%s to the provider',
    async (enableThinking) => {
      const { request, service } = setup(completion('ok'));
      const input = dto();
      input.runtime.ai.enableThinking = enableThinking;
      await service.generate(input, signal());
      expect(configOf(request).data).toMatchObject({ enable_thinking: enableThinking });
    },
  );

  it('uses the Node http adapter with no deadline, no redirects, no proxy and the default byte budget', async () => {
    const { request, service } = setup(completion('ok'));
    await service.generate(dto(), signal());
    expect(configOf(request)).toMatchObject({
      adapter: 'http',
      timeout: 0,
      maxRedirects: 0,
      proxy: false,
      maxContentLength: AI_MODEL_LIMITS.maxResponseBytes,
      responseType: 'text',
      validateStatus: expect.any(Function),
    });
  });

  it.each([4096, 8193, 1_000_000])(
    'ignores legacy maxTokens=%i and sends no output-token cap to the provider',
    async (maxTokens) => {
      const { request, service } = setup(completion('generated text'));
      await expect(service.generate(dto({ maxTokens }), signal())).resolves.toEqual({
        text: 'generated text',
      });
      const body = bodyOf(configOf(request));
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('max_output_tokens');
      expect(body).toMatchObject({
        model: 'gpt-test',
        stream: false,
        messages: [{ role: 'user', content: '请总结' }],
      });
    },
  );

  it('has no backend AI deadline or background timer and follows only the caller cancellation signal', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const controller = new AbortController();
    let complete: ((response: StubResponse) => void) | undefined;
    const request = stubAxios(
      () =>
        new Promise<StubResponse>((resolve) => {
          complete = resolve;
        }),
    );
    const service = new AiTextCapabilityService(new AiTextClientService());
    let settled = false;
    try {
      const pending = service.generate(dto(), controller.signal).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(240_000);
      expect(settled).toBe(false);
      expect(timeout).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(request).toHaveBeenCalledOnce();
      const config = configOf(request);
      expect(config.timeout).toBe(0);
      expect(config.signal).toBeInstanceOf(AbortSignal);
      expect(config.signal!.aborted).toBe(false);
      expect(controller.signal.aborted).toBe(false);
      complete?.(completion('slow AI response'));
      await expect(pending).resolves.toEqual({ text: 'slow AI response' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      complete?.(completion('cleanup'));
      vi.useRealTimers();
    }
  });

  it('omits the system message when it is blank and normalizes a trailing slash in baseUrl', async () => {
    const { request, service } = setup(completion('ok'));
    await service.generate(dto({ systemPrompt: '   ' }, 'https://api.example.com/v1/'), signal());
    const config = configOf(request);
    expect(config.url).toBe('https://api.example.com/v1/chat/completions');
    expect(bodyOf(config).messages).toEqual([{ role: 'user', content: '请总结' }]);
  });

  it.each([
    'https://localhost:8443/v1',
    'https://service.internal:9443/v1',
    'https://intranet/v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.1:8443/v1',
    'https://[::1]/v1',
    'https://[fd00::1]:9443/v1',
    'https://api.example.com:8443/v1/',
  ])('passes the configured HTTPS address %s directly to the transport', async (baseUrl) => {
    const { request, service } = setup(completion('generated text'));
    await expect(
      service.generate(dto({ systemPrompt: 'system' }, baseUrl), signal()),
    ).resolves.toEqual({ text: 'generated text' });
    expect(request).toHaveBeenCalledOnce();
    const config = configOf(request);
    const configured = new URL(baseUrl);
    const sent = new URL(config.url!);
    expect(config.url).toBe(`${baseUrl.replace(/\/+$/, '')}/chat/completions`);
    expect(sent.hostname).toBe(configured.hostname);
    expect(sent.port).toBe(configured.port);
    expect(config.method).toBe('POST');
    expect(config.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    });
    expect(config.signal).toBeInstanceOf(AbortSignal);
    expect(config.data).toEqual({
      model: 'gpt-test',
      stream: false,
      enable_thinking: false,
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: '请总结' },
      ],
    });
  });

  it('has no hidden local fallback: blank prompt is rejected before any request', async () => {
    const { request, service } = setup(completion('x'));
    const error = await failure(
      service.generate(dto({ prompt: '  \n ' }), signal()),
      WorkflowCapabilityException,
    );
    expect(error.getStatus()).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['http://localhost:3000/v1/', 'http://localhost:3000/v1/chat/completions'],
    [
      'https://user:pass@api.example.com/v1',
      'https://user:pass@api.example.com/v1/chat/completions',
    ],
    ['https://api.example.com/v1?key=1', 'https://api.example.com/v1/chat/completions?key=1'],
    ['https://api.example.com/v1#frag', 'https://api.example.com/v1/chat/completions#frag'],
    [
      'http://user:pass@intranet:8080/v1/?key=1#frag',
      'http://user:pass@intranet:8080/v1/chat/completions?key=1#frag',
    ],
  ])(
    'constructs the endpoint for %s without imposing an address policy',
    async (baseUrl, endpoint) => {
      const { request, service } = setup(completion('generated text'));
      await expect(service.generate(dto({}, baseUrl), signal())).resolves.toEqual({
        text: 'generated text',
      });
      expect(request).toHaveBeenCalledOnce();
      const config = configOf(request);
      expect(config.url).toBe(endpoint);
      const configured = new URL(baseUrl);
      const sent = new URL(config.url!);
      expect(sent.username).toBe(configured.username);
      expect(sent.password).toBe(configured.password);
      expect(sent.search).toBe(configured.search);
      expect(sent.hash).toBe(configured.hash);
      expect(config.method).toBe('POST');
      expect(config.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
      expect(config.data).toEqual({
        model: 'gpt-test',
        stream: false,
        enable_thinking: false,
        messages: [{ role: 'user', content: '请总结' }],
      });
      expect(JSON.stringify(config.data)).not.toContain(API_KEY);
      expect(JSON.stringify(config.data)).not.toContain('user:pass');
    },
  );

  it.each([
    ['unparseable URL', 'not a url'],
    ['non-HTTP protocol', 'ftp://api.example.com/v1'],
  ])(
    'rejects %s with a controlled 400 before any network access without echoing credentials',
    async (_name, baseUrl) => {
      const { request, service } = setup(completion('x'));
      const error = await failure(service.generate(dto({}, baseUrl), signal()));
      expect(error).not.toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(WorkflowCapabilityException);
      expect(error.getStatus()).toBe(400);
      expect(request).not.toHaveBeenCalled();
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).not.toContain(baseUrl);
    },
  );

  it('rejects an upstream-truncated result without treating it as complete output', async () => {
    const { service } = setup(completion('{"partial":', 'length'));
    const error = await failure(service.generate(dto(), signal()));
    expect(error.getStatus()).toBe(422);
    expect(error.message).toContain('上游截断');
    expect(error.message).not.toContain('maxTokens');
  });

  it.each([
    ['content_filter', completion('x', 'content_filter')],
    ['tool_calls', completion('x', 'tool_calls')],
    ['null finish_reason', completion('{"partial":', null)],
    ['numeric finish_reason', completion('{"partial":', 1)],
    [
      'missing finish_reason',
      {
        status: 200,
        headers: {},
        data: JSON.stringify({ choices: [{ message: { content: '{"items":[1,2' } }] }),
      },
    ],
  ])('requires finish_reason to be exactly stop: rejects %s', async (_name, response) => {
    const { service } = setup(response);
    const error = await failure(service.generate(dto(), signal()));
    expect(error.getStatus()).toBe(422);
    expect(error.message).not.toContain('partial');
  });

  it.each([
    ['empty content', completion('   ')],
    ['non-string content', completion(['a'])],
    ['multimodal content parts', completion([{ type: 'text', text: 'hello' }])],
    ['no choices', { status: 200, headers: {}, data: '{"choices":[]}' }],
    ['invalid JSON', { status: 200, headers: {}, data: '<html>' }],
  ])('rejects %s as a bad upstream response', async (_name, response) => {
    const { service } = setup(response);
    expect((await failure(service.generate(dto(), signal()))).getStatus()).toBe(502);
  });

  it('rejects text longer than the output budget', async () => {
    const { service } = setup(completion('字'.repeat(500_001)));
    expect((await failure(service.generate(dto(), signal()))).getStatus()).toBe(422);
  });

  it('rejects a response body larger than the byte budget even if the transport did not stop it', async () => {
    const { service } = setup({
      status: 200,
      headers: {},
      data: 'x'.repeat(AI_MODEL_LIMITS.maxResponseBytes + 1),
    });
    const error = await failure(service.generate(dto(), signal()));
    expect(error.getStatus()).toBe(422);
    expect(error.message).toContain('长度预算');
  });

  it('maps a transport maxContentLength failure to 422 without echoing the raw error', async () => {
    const { request, service } = setup(() => {
      throw new AxiosError(
        `maxContentLength size of 2097152 exceeded ${API_KEY}`,
        'ERR_BAD_RESPONSE',
      );
    });
    const error = await failure(service.generate(dto(), signal()));
    expect(error.getStatus()).toBe(422);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain('2097152');
    expect(configOf(request).maxContentLength).toBe(AI_MODEL_LIMITS.maxResponseBytes);
  });

  it('maps upstream HTTP errors without echoing the upstream body or credentials', async () => {
    const { service } = setup({
      status: 401,
      headers: {},
      data: JSON.stringify({ error: { message: `bad key ${API_KEY}`, prompt: '请总结' } }),
    });
    const error = await failure(service.generate(dto(), signal()));
    expect(error.getStatus()).toBe(502);
    expect(error.message).toContain('401');
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain('bad key');
  });

  it.each([
    [
      'axios network error',
      () => new AxiosError(`connect ECONNREFUSED 10.0.0.9:443 ${API_KEY}`, 'ECONNREFUSED'),
    ],
    ['axios timeout code', () => new AxiosError(`timeout of 5ms exceeded ${API_KEY}`, 'ETIMEDOUT')],
    ['plain error', () => new Error(`socket hang up ${API_KEY} 请总结`)],
  ])('maps %s to a safe 502 that does not echo the raw error', async (_name, makeError) => {
    const { service } = setup(() => {
      throw makeError();
    });
    const error = await failure(service.generate(dto(), signal()));
    expect(error.getStatus()).toBe(502);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain('ECONNREFUSED');
    expect(error.message).not.toContain('10.0.0.9');
    expect(error.message).not.toContain('socket hang up');
    expect(error.message).not.toContain('请总结');
  });

  it('passes a signal that follows caller cancellation and rejects with the caller reason', async () => {
    const controller = new AbortController();
    const reason = new Error('user-stop');
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { request, service } = setup((config) => hangUntilAborted(config, started));
    const pending = service.generate(dto(), controller.signal);
    await hasStarted;
    const passed = configOf(request).signal!;
    expect(passed.aborted).toBe(false);
    controller.abort(reason);
    expect(passed.aborted).toBe(true);
    await expect(pending).rejects.toBe(reason);
  });

  it('rejects a pre-aborted signal without any transport call', async () => {
    const { request, service } = setup(completion('x'));
    const controller = new AbortController();
    const reason = new Error('stopped-before-start');
    controller.abort(reason);
    await expect(service.generate(dto(), controller.signal)).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('AiTextClientService', () => {
  const base = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: API_KEY,
    model: 'gpt-test',
    prompt: '你好',
  };

  it('works without a caller signal and without any deadline', async () => {
    vi.useFakeTimers();
    try {
      const request = stubAxios(completion('no signal needed'));
      await expect(new AiTextClientService().generate(base)).resolves.toBe('no signal needed');
      const config = configOf(request);
      expect(config.timeout).toBe(0);
      expect(config.signal).toBeInstanceOf(AbortSignal);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies an explicit timeout only when requested and reports a safe 504', async () => {
    const request = stubAxios((config) => hangUntilAborted(config));
    const error = await failure(new AiTextClientService().generate({ ...base, timeoutMs: 20 }));
    expect(error.getStatus()).toBe(504);
    expect(error.message).not.toContain(API_KEY);
    expect(configOf(request).timeout).toBe(0);
  });

  it('keeps the caller reason when the caller cancels before an explicit timeout fires', async () => {
    const controller = new AbortController();
    const reason = new Error('caller-stop');
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    stubAxios((config) => hangUntilAborted(config, started));
    const pending = new AiTextClientService().generate({
      ...base,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    await hasStarted;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('honours optional prompt, response-byte and output budgets and temperature', async () => {
    const request = stubAxios(completion('abcdef'));
    const client = new AiTextClientService();
    const promptError = await failure(
      client.generate({ ...base, prompt: 'x'.repeat(11), maxPromptCharacters: 10 }),
    );
    expect(promptError.getStatus()).toBe(422);
    expect(request).not.toHaveBeenCalled();
    const outputError = await failure(client.generate({ ...base, maxOutputCharacters: 5 }));
    expect(outputError.getStatus()).toBe(422);
    await client.generate({ ...base, temperature: 0.2, maxResponseBytes: 4096 });
    const config = configOf(request, 1);
    expect(config.maxContentLength).toBe(4096);
    expect(bodyOf(config)).toMatchObject({ temperature: 0.2 });
  });

  it('is a plain injectable with no constructor dependencies', () => {
    expect(AiTextClientService.length).toBe(0);
    expect(Reflect.getMetadata('design:paramtypes', AiTextClientService)).toBeUndefined();
  });
});
