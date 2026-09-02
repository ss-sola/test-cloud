import { describe, expect, it, vi } from 'vitest';
import { FeishuApiException } from '../client/feishu/feishu-http-client.service';
import { FeishuSheetsClientService } from '../client/feishu/feishu-sheets-client.service';
import type { FeishuRequestContext } from '../client/feishu/feishu.types';

const context: FeishuRequestContext = {
  appId: 'app-id',
  appSecret: 'app-secret',
  requestTimeoutMs: 8_000,
  maxRetries: 1,
};

describe('FeishuSheetsClientService', () => {
  it('passes request context to sheet requests', async () => {
    const authClient = { getTenantAccessToken: vi.fn().mockResolvedValue('tenant-token') };
    const httpClient = {
      request: vi.fn().mockResolvedValue({
        code: 0,
        data: { sheets: [{ sheet_id: 'sheet-id' }] },
      }),
    };
    const service = new FeishuSheetsClientService(httpClient as never, authClient as never);

    await expect(service.listSheets('spreadsheet-token', context)).resolves.toEqual([
      { sheet_id: 'sheet-id' },
    ]);
    expect(authClient.getTenantAccessToken).toHaveBeenCalledWith(false, context);
    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/open-apis/sheets/v3/spreadsheets/spreadsheet-token/sheets/query',
        accessToken: 'tenant-token',
      }),
      context,
    );
  });

  it('refreshes the request-scoped token once after a 401', async () => {
    const authClient = {
      getTenantAccessToken: vi
        .fn()
        .mockResolvedValueOnce('stale-token')
        .mockResolvedValueOnce('fresh-token'),
      invalidate: vi.fn(),
    };
    const httpClient = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new FeishuApiException('unauthorized', 401, false))
        .mockResolvedValueOnce({ code: 0, data: { valueRange: { values: [['value']] } } }),
    };
    const service = new FeishuSheetsClientService(httpClient as never, authClient as never);

    await expect(
      service.readValues('spreadsheet-token', 'sheet-id!A1:B1', context),
    ).resolves.toEqual([['value']]);
    expect(authClient.invalidate).toHaveBeenCalledWith(context);
    expect(authClient.getTenantAccessToken).toHaveBeenNthCalledWith(1, false, context);
    expect(authClient.getTenantAccessToken).toHaveBeenNthCalledWith(2, true, context);
    expect(httpClient.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accessToken: 'fresh-token' }),
      context,
    );
  });
});
