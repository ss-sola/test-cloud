import { describe, expect, it, vi } from 'vitest';
import { FeishuAuthClientService } from '../client/feishu/feishu-auth-client.service';
import type { FeishuRequestContext } from '../client/feishu/feishu.types';

const contextA: FeishuRequestContext = {
  appId: 'app-a',
  appSecret: 'secret-a',
  requestTimeoutMs: 8_000,
  maxRetries: 1,
};
const contextB: FeishuRequestContext = {
  appId: 'app-b',
  appSecret: 'secret-b',
  requestTimeoutMs: 9_000,
  maxRetries: 0,
};

describe('FeishuAuthClientService', () => {
  it('caches tokens independently for each request credential set', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, tenant_access_token: 'token-a', expire: 3600 })
      .mockResolvedValueOnce({ code: 0, tenant_access_token: 'token-b', expire: 3600 })
      .mockResolvedValueOnce({ code: 0, tenant_access_token: 'token-a-new', expire: 3600 });
    const service = new FeishuAuthClientService({ request } as never);

    await expect(service.getTenantAccessToken(false, contextA)).resolves.toBe('token-a');
    await expect(service.getTenantAccessToken(false, contextA)).resolves.toBe('token-a');
    await expect(service.getTenantAccessToken(false, contextB)).resolves.toBe('token-b');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: { app_id: 'app-a', app_secret: 'secret-a' },
      }),
      contextA,
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: { app_id: 'app-b', app_secret: 'secret-b' },
      }),
      contextB,
    );

    service.invalidate(contextA);
    await expect(service.getTenantAccessToken(false, contextA)).resolves.toBe('token-a-new');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('shares a concurrent token refresh for the same credentials', async () => {
    let resolveRequest!: (value: unknown) => void;
    const request = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const service = new FeishuAuthClientService({ request } as never);

    const first = service.getTenantAccessToken(false, contextA);
    const second = service.getTenantAccessToken(false, contextA);
    expect(request).toHaveBeenCalledTimes(1);

    resolveRequest({ code: 0, tenant_access_token: 'shared-token', expire: 3600 });
    await expect(Promise.all([first, second])).resolves.toEqual(['shared-token', 'shared-token']);
  });
});
