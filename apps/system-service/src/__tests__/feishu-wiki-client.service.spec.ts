import { describe, expect, it } from 'vitest';
import { extractWikiToken } from '../client/feishu/feishu-wiki-client.service';

describe('extractWikiToken', () => {
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
