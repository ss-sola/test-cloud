import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuHttpClientService } from '../client/feishu/feishu-http-client.service';

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FeishuHttpClientService', () => {
  it('sends only JSON and bearer headers without forwarding browser credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 0, data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new FeishuHttpClientService();

    await expect(
      service.request({
        method: 'GET',
        path: '/open-apis/example',
        accessToken: 'tenant-token',
        query: { token: 'wiki-token' },
      }),
    ).resolves.toEqual({ code: 0, data: { ok: true } });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/example?token=wiki-token',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer tenant-token',
        },
      }),
    );
  });

  it('retries a temporary HTTP failure and returns the successful response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'temporary' }, 503))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new FeishuHttpClientService();

    await expect(service.request({ method: 'GET', path: '/open-apis/example' })).resolves.toEqual({
      code: 0,
      data: { ok: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permission failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'forbidden' }, 403));
    vi.stubGlobal('fetch', fetchMock);
    const service = new FeishuHttpClientService();

    await expect(
      service.request({ method: 'GET', path: '/open-apis/example' }),
    ).rejects.toMatchObject({
      status: 403,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses request-level retry settings instead of global config', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'temporary' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const service = new FeishuHttpClientService();

    await expect(
      service.request(
        { method: 'GET', path: '/open-apis/example' },
        {
          appId: 'app-id',
          appSecret: 'app-secret',
          requestTimeoutMs: 8_000,
          maxRetries: 0,
        },
      ),
    ).rejects.toMatchObject({ status: 503, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes a safe Feishu error message for HTTP 400 responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 99991663, msg: 'invalid spreadsheet token' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const service = new FeishuHttpClientService();

    await expect(
      service.request({ method: 'GET', path: '/open-apis/example' }),
    ).rejects.toMatchObject({
      status: 400,
      apiCode: 99991663,
      message: '飞书 API 调用失败（请求飞书接口，HTTP 400：invalid spreadsheet token）。',
    });
  });
});
