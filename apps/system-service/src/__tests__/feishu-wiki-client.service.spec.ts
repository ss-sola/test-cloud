import { describe, expect, it, vi } from 'vitest';
import {
  extractSheetId,
  extractSheetToken,
  extractWikiToken,
  FeishuWikiClientService,
} from '../client/feishu/feishu-wiki-client.service';

describe('extractWikiToken', () => {
  it('accepts a direct Feishu Sheet URL without resolving a Wiki node', async () => {
    const url = 'https://tthdtech.feishu.cn/sheets/ZVPMsdbHphQOdetitZbcMu7NnEd?sheet=a0ab9d';
    const httpClient = { request: vi.fn() };
    const authClient = { getTenantAccessToken: vi.fn() };
    const service = new FeishuWikiClientService(httpClient as never, authClient as never);

    expect(extractSheetToken(url)).toBe('ZVPMsdbHphQOdetitZbcMu7NnEd');
    expect(extractSheetId(url)).toBe('a0ab9d');
    await expect(service.resolveSpreadsheet(url)).resolves.toEqual({
      spreadsheetToken: 'ZVPMsdbHphQOdetitZbcMu7NnEd',
      sheetId: 'a0ab9d',
    });
    expect(httpClient.request).not.toHaveBeenCalled();
    expect(authClient.getTenantAccessToken).not.toHaveBeenCalled();
  });

  it('accepts Feishu and Lark Wiki URLs', () => {
    expect(extractWikiToken('https://tthdtech.feishu.cn/wiki/wiki-token')).toBe('wiki-token');
    expect(extractWikiToken('https://example.larksuite.com/wiki/lark-token?x=1')).toBe(
      'lark-token',
    );
  });

  it('rejects non-Wiki or untrusted URLs', () => {
    expect(() => extractWikiToken('https://example.com/wiki/wiki-token')).toThrow(/不受支持/);
    expect(() => extractWikiToken('https://tthdtech.feishu.cn/sheets/sheet-token')).toThrow(
      /不受支持/,
    );
  });
});
