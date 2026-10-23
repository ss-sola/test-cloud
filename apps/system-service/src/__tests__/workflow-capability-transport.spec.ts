import { Logger } from '@nestjs/common';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalHttpClientService } from '../client/external/external-http-client.service';
import type { ExternalHttpRequest } from '../client/external/external-http-client.service';
import { WorkflowCapabilityException } from '../modules/workflow-capabilities/workflow-capability.exception';

const SECRET = 'SECRET_TOKEN_9f3a7c';
const nativeFetch = globalThis.fetch;
const encoder = new TextEncoder();
let server: Server;
let port: number;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let seenRequests = 0;
let transport: ExternalHttpClientService;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let errorLogs: unknown[][] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seenRequests += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  errorLogs = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
    errorLogs.push(args);
  });
  seenRequests = 0;
  transport = new ExternalHttpClientService();
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('{"ok":true}', {
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'request-123' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  handler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 提供完整请求参数；测试默认替换 fetch，不向示例域名发起真实连接。 */
function options(overrides: Partial<ExternalHttpRequest> = {}): ExternalHttpRequest {
  return {
    url: new URL('https://api.example.com/v1/items?x=1'),
    method: 'GET',
    headers: { Authorization: `Bearer ${SECRET}` },
    maxResponseBytes: 1024,
    ...overrides,
  };
}

/** 提前接住拒绝，避免定时推进与手动取消期间产生未处理的 rejection。 */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the external request to fail.');
    },
    (error: unknown) => error,
  );
}

/** 只用于取消、超时和预算等仍由能力层控制的异常。 */
async function controlledFailure(promise: Promise<unknown>): Promise<WorkflowCapabilityException> {
  const error = await failure(promise);
  expect(error).toBeInstanceOf(WorkflowCapabilityException);
  return error as WorkflowCapabilityException;
}

/** 保留 Error 的非枚举 message/stack，兼容日志字符串或结构化对象。 */
function loggedText(): string {
  return inspect(errorLogs, { depth: 20, colors: false });
}

/** 创建由测试决定完成时间的 fetch 或流读取结果。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('ExternalHttpClientService fetch requests', () => {
  it.each([
    'https://api.example.com/v1',
    'http://localhost:8080/v1',
    'http://10.0.0.1:3000/v1',
    'http://intranet/v1',
    'https://localhost:8443/v1',
    'https://service.internal:9443/v1',
    'https://intranet/v1',
    'https://printer.local/v1',
    'https://127.0.0.1:8443/v1',
    'https://[::1]:8443/v1',
    'https://2130706433/v1',
    'ftp://api.example.com/resource',
    `https://PRIVATE_USER:${SECRET}@service.internal:8443/v1?apiKey=${SECRET}#section`,
  ])('passes %s directly to fetch without address or protocol prechecks', async (address) => {
    const url = new URL(address);
    const response = await transport.request(options({ url }));
    expect(response).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(seenRequests).toBe(0);
  });

  it('forwards the original headers and body without adding transport headers', async () => {
    const headers = {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      'X-Custom': 'unchanged',
    };
    const body = '{"v":"文本"}';
    const request = options({ method: 'PUT', headers, body });
    const response = await transport.request(request);
    const init = fetchMock.mock.calls[0][1];
    expect(fetchMock.mock.calls[0][0]).toBe(request.url);
    expect(init).toEqual({
      method: 'PUT',
      headers,
      body,
      signal: expect.any(AbortSignal),
      redirect: 'manual',
    });
    expect(init?.headers).toBe(headers);
    expect(headers).toEqual({
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      'X-Custom': 'unchanged',
    });
    expect(response.headers).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'request-123',
    });
    expect(Object.getPrototypeOf(response.headers)).toBe(Object.prototype);
  });

  it('returns HTTP errors with the complete upstream body instead of manufacturing an exception', async () => {
    const body = JSON.stringify({
      error: { message: 'capacity exhausted', type: 'server_error', code: 'overloaded' },
    });
    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 500,
        statusText: 'Provider Unavailable',
        headers: { 'X-Upstream': 'provider' },
      }),
    );
    await expect(transport.request(options())).resolves.toEqual({
      status: 500,
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-upstream': 'provider' },
      body,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(loggedText()).toContain('500');
    expect(loggedText()).toContain('Provider Unavailable');
    expect(loggedText()).toContain('capacity exhausted');
    expect(loggedText()).toContain('server_error');
    expect(loggedText()).toContain('overloaded');
  });

  it('does not follow redirects or retry and logs their upstream body', async () => {
    const body = 'The resource moved to another endpoint.';
    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 302,
        statusText: 'Found',
        headers: { Location: 'https://other.internal/resource' },
      }),
    );
    const error = await controlledFailure(transport.request(options()));
    expect(error.getStatus()).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
    expect(loggedText()).toContain('302');
    expect(loggedText()).toContain(body);
  });

  it('supports an empty response body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(transport.request(options())).resolves.toEqual({
      status: 204,
      headers: {},
      body: '',
    });
  });
});

describe('fetch cancellation and optional deadlines', () => {
  it('does not create an application deadline when timeoutMs is omitted', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const upstream = deferred<Response>();
    fetchMock.mockReturnValue(upstream.promise);
    let settled = false;
    const pending = transport.request(options()).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(settled).toBe(false);
    expect(timeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    upstream.resolve(new Response('{"late":true}'));
    await expect(pending).resolves.toMatchObject({ status: 200, body: '{"late":true}' });
  });

  it('rejects already cancelled requests before invoking fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await controlledFailure(transport.request(options({ signal: controller.signal })))
      ).getStatus(),
    ).toBe(499);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'ends unlimited requests even when fetch ignores abort and later %ss',
    async (completion) => {
      vi.useFakeTimers();
      const upstream = deferred<Response>();
      fetchMock.mockReturnValue(upstream.promise);
      const controller = new AbortController();
      const pending = controlledFailure(transport.request(options({ signal: controller.signal })));
      await vi.advanceTimersByTimeAsync(240_000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      const stopped = await pending;
      expect(stopped.getStatus()).toBe(499);
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      if (completion === 'resolve') upstream.resolve(new Response('{"late":true}'));
      else
        upstream.reject(
          Object.assign(new Error('late connection failure'), { code: 'ECONNRESET' }),
        );
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toBe(stopped);
      expect(errorLogs).toHaveLength(0);
    },
  );

  it('enforces an explicit native timeout even when fetch ignores its abort signal', async () => {
    const upstream = deferred<Response>();
    fetchMock.mockReturnValue(upstream.promise);
    const pending = controlledFailure(transport.request(options({ timeoutMs: 50 })));
    const timedOut = await pending;
    expect(timedOut.getStatus()).toBe(504);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    upstream.resolve(new Response('{"late":true}'));
    await Promise.resolve();
    expect(await pending).toBe(timedOut);
  });

  it('keeps a caller stop distinct from an explicit native deadline', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = controlledFailure(
      transport.request(options({ timeoutMs: 50, signal: controller.signal })),
    );
    await Promise.resolve();
    controller.abort();
    const stopped = await pending;
    expect(stopped.getStatus()).toBe(499);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await pending).toBe(stopped);
    expect(errorLogs).toHaveLength(0);
  });

  it('does not turn a completed request into a failure when its native deadline later expires', async () => {
    const response = await transport.request(options({ timeoutMs: 50 }));
    expect(response).toMatchObject({ status: 200 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(response).toMatchObject({ status: 200 });
    expect(errorLogs).toHaveLength(0);
  });

  it.each(['caller', 'timeout'] as const)(
    'ends a pending body read on %s cancellation even if the reader ignores the signal',
    async (source) => {
      const chunk = deferred<ReadableStreamReadResult<Uint8Array>>();
      const cancel = vi.fn().mockResolvedValue(undefined);
      const read = vi.fn().mockReturnValue(chunk.promise);
      const reader = { read, cancel, releaseLock: vi.fn() };
      fetchMock.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: { getReader: () => reader },
      } as unknown as Response);
      const controller = new AbortController();
      const pending = controlledFailure(
        transport.request(
          options({
            signal: controller.signal,
            ...(source === 'timeout' ? { timeoutMs: 50 } : {}),
          }),
        ),
      );
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce(), { interval: 1 });
      if (source === 'caller') controller.abort();
      expect((await pending).getStatus()).toBe(source === 'caller' ? 499 : 504);
      expect(cancel).toHaveBeenCalled();
      chunk.resolve({ done: false, value: encoder.encode('late response') });
      await Promise.resolve();
      await Promise.resolve();
      expect(read).toHaveBeenCalledOnce();
      expect(errorLogs).toHaveLength(0);
    },
  );
});

describe('fetch response stream budgets', () => {
  it('accepts an exactly fitting UTF-8 byte budget across split multibyte characters', async () => {
    const bytes = encoder.encode('文本');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(body));
    await expect(
      transport.request(options({ maxResponseBytes: bytes.length })),
    ).resolves.toMatchObject({ body: '文本' });
  });

  it('counts actual UTF-8 bytes, cancels an over-budget reader and does not await another chunk', async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('文本'));
          },
          cancel,
        }),
      ),
    );
    const error = await controlledFailure(transport.request(options({ maxResponseBytes: 5 })));
    expect(error.getStatus()).toBe(502);
    expect(error.message).toContain('大小预算');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('enforces the budget from streamed bytes without a Content-Length header', async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('x'.repeat(600)));
            controller.enqueue(encoder.encode('y'.repeat(600)));
          },
          cancel,
        }),
      ),
    );
    expect((await controlledFailure(transport.request(options()))).message).toContain('大小预算');
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('raw transport errors and useful redacted diagnostics', () => {
  it.each([
    ['ENOTFOUND', 'getaddrinfo'],
    ['ECONNREFUSED', 'connect'],
    ['ECONNRESET', 'read'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'connect'],
  ])(
    'rethrows the original %s Error and logs its message, stack and native fields',
    async (code, syscall) => {
      const native = Object.assign(new Error(`native connection detail ${SECRET}`), {
        code,
        syscall,
        address: '127.0.0.1',
        port: 8443,
        errno: -4078,
      });
      native.stack = `Error: ${native.message}\n    at transportFailure (provider-native.js:17:9)`;
      fetchMock.mockRejectedValue(native);
      expect(await failure(transport.request(options()))).toBe(native);
      expect(native.message).toContain(SECRET);
      expect(errorLogs.length).toBeGreaterThan(0);
      const logged = loggedText();
      for (const detail of [
        'native connection detail',
        'provider-native.js:17:9',
        code,
        syscall,
        '127.0.0.1',
        '8443',
        '-4078',
      ])
        expect(logged).toContain(detail);
      expect(logged).toContain('[REDACTED]');
      expect(logged).not.toContain(SECRET);
    },
  );

  it('preserves TypeError, nested cause and aggregate IPv4/IPv6 connection diagnostics', async () => {
    const inner = Object.assign(new Error(`connect refused ${SECRET}`), {
      code: 'ECONNREFUSED',
      address: '::1',
      port: 443,
    });
    const aggregate = new AggregateError(
      [
        inner,
        Object.assign(new Error('IPv4 route unavailable'), {
          code: 'ENETUNREACH',
          address: '127.0.0.1',
          port: 443,
        }),
      ],
      'connection attempts exhausted',
    );
    const native = new TypeError('fetch failed with native cause', { cause: aggregate });
    native.stack = 'TypeError: fetch failed with native cause\n    at fetch-native.js:23:7';
    fetchMock.mockRejectedValue(native);
    expect(await failure(transport.request(options()))).toBe(native);
    const logged = loggedText();
    for (const detail of [
      'TypeError',
      'fetch failed with native cause',
      'fetch-native.js:23:7',
      'AggregateError',
      'connection attempts exhausted',
      'connect refused',
      'ECONNREFUSED',
      '::1',
      'IPv4 route unavailable',
      'ENETUNREACH',
      '127.0.0.1',
    ])
      expect(logged).toContain(detail);
    expect(logged).not.toContain(SECRET);
  });

  it('rethrows a synchronous fetch failure without wrapping or losing its error code', async () => {
    const native = Object.assign(new TypeError(`unsupported native request ${SECRET}`), {
      code: 'ERR_INVALID_URL',
    });
    fetchMock.mockImplementation(() => {
      throw native;
    });
    expect(await failure(transport.request(options()))).toBe(native);
    expect(loggedText()).toContain('unsupported native request');
    expect(loggedText()).toContain('ERR_INVALID_URL');
    expect(loggedText()).not.toContain(SECRET);
  });

  it('rethrows the original response read error and prints its cause and stack once', async () => {
    const cause = Object.assign(new Error('socket closed unexpectedly'), {
      code: 'ECONNRESET',
      syscall: 'read',
    });
    const native = new TypeError(`body stream terminated ${SECRET}`, { cause });
    native.stack = `TypeError: ${native.message}\n    at response-reader.js:42:3`;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(native);
          },
        }),
      ),
    );
    expect(await failure(transport.request(options()))).toBe(native);
    expect(errorLogs.length).toBeGreaterThan(0);
    for (const detail of [
      'body stream terminated',
      'response-reader.js:42:3',
      'socket closed unexpectedly',
      'ECONNRESET',
      'read',
    ])
      expect(loggedText()).toContain(detail);
    expect(loggedText()).not.toContain(SECRET);
  });

  it('redacts known request secrets from raw error strings without dumping request bodies or headers', async () => {
    const url = new URL(
      `https://PRIVATE_USER:${SECRET}@api.example.com/private?apiKey=QUERY_SECRET_93ad&tenant=demo`,
    );
    const native = new Error(`native diagnosis ${url.href} token ${SECRET}`);
    fetchMock.mockRejectedValue(native);
    expect(
      await failure(
        transport.request(
          options({ url, method: 'POST', body: JSON.stringify({ prompt: 'PRIVATE_PROMPT_98fe' }) }),
        ),
      ),
    ).toBe(native);
    const logged = loggedText();
    expect(logged).toContain('native diagnosis');
    expect(logged).toContain('[REDACTED]');
    for (const secret of [SECRET, 'PRIVATE_USER', 'QUERY_SECRET_93ad', 'PRIVATE_PROMPT_98fe'])
      expect(logged).not.toContain(secret);
  });

  it('logs provider error content while redacting JSON secrets and echoed request fields only in logs', async () => {
    const body = JSON.stringify({
      error: {
        message: `quota exhausted for deployment ${SECRET}`,
        type: 'quota_error',
        code: 'insufficient_quota',
      },
      access_token: 'UPSTREAM_TOKEN_17af',
      nested: { api_key: 'UPSTREAM_KEY_62bd', password: 'UPSTREAM_PASSWORD_43ac' },
      prompt: 'PRIVATE_PROMPT_98fe',
      messages: [{ role: 'user', content: 'PRIVATE_MESSAGE_28df' }],
    });
    fetchMock.mockResolvedValue(
      new Response(body, { status: 429, statusText: 'Too Many Requests' }),
    );
    const response = await transport.request(
      options({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'PRIVATE_PROMPT_98fe',
          messages: [{ role: 'user', content: 'PRIVATE_MESSAGE_28df' }],
        }),
      }),
    );
    expect(response).toMatchObject({ status: 429, body });
    const logged = loggedText();
    for (const detail of [
      '429',
      'Too Many Requests',
      'quota exhausted for deployment',
      'quota_error',
      'insufficient_quota',
      '[REDACTED]',
    ])
      expect(logged).toContain(detail);
    for (const secret of [
      SECRET,
      'UPSTREAM_TOKEN_17af',
      'UPSTREAM_KEY_62bd',
      'UPSTREAM_PASSWORD_43ac',
      'PRIVATE_PROMPT_98fe',
      'PRIVATE_MESSAGE_28df',
    ])
      expect(logged).not.toContain(secret);
  });
});

describe('real fetch against a local HTTP server only', () => {
  it('uses native fetch for local requests and sends the original request body', async () => {
    vi.stubGlobal('fetch', nativeFetch);
    let received = '';
    let method = '';
    let authorization = '';
    handler = (req, res) => {
      method = req.method ?? '';
      authorization = req.headers.authorization ?? '';
      req.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
      });
      req.on('end', () => res.end('{"saved":true}'));
    };
    const response = await transport.request(
      options({
        url: new URL(`http://127.0.0.1:${port}/v1?tenant=demo`),
        method: 'POST',
        body: '{"v":"文本"}',
        timeoutMs: 2000,
      }),
    );
    expect(response).toMatchObject({ status: 200, body: '{"saved":true}' });
    expect({ received, method, authorization }).toEqual({
      received: '{"v":"文本"}',
      method: 'POST',
      authorization: `Bearer ${SECRET}`,
    });
    expect(seenRequests).toBe(1);
  });

  it('lets fetch decode gzip and budgets the decompressed response rather than compressed Content-Length', async () => {
    vi.stubGlobal('fetch', nativeFetch);
    const text = '文本'.repeat(100);
    const compressed = gzipSync(text);
    expect(compressed.byteLength).toBeLessThan(100);
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.byteLength });
      res.end(compressed);
    };
    const url = new URL(`http://127.0.0.1:${port}/compressed`);
    await expect(
      transport.request(
        options({ url, maxResponseBytes: Buffer.byteLength(text), timeoutMs: 2000 }),
      ),
    ).resolves.toMatchObject({ status: 200, body: text });
    const error = await controlledFailure(
      transport.request(options({ url, maxResponseBytes: 100, timeoutMs: 2000 })),
    );
    expect(error.getStatus()).toBe(502);
    expect(error.message).toContain('大小预算');
  });

  it('returns and logs an actual HTTP 500 body instead of replacing the provider message', async () => {
    vi.stubGlobal('fetch', nativeFetch);
    const body = JSON.stringify({
      error: {
        message: 'upstream deployment is offline',
        type: 'server_error',
        code: 'deployment_unavailable',
      },
    });
    handler = (_req, res) => {
      res.writeHead(500, 'Provider Offline', { 'Content-Type': 'application/json' });
      res.end(body);
    };
    await expect(
      transport.request(
        options({ url: new URL(`http://127.0.0.1:${port}/failed`), timeoutMs: 2000 }),
      ),
    ).resolves.toMatchObject({ status: 500, body });
    for (const detail of [
      '500',
      'Provider Offline',
      'upstream deployment is offline',
      'server_error',
      'deployment_unavailable',
    ])
      expect(loggedText()).toContain(detail);
    expect(seenRequests).toBe(1);
  });
});
