import { Injectable } from '@nestjs/common';
import { ParamsErrorException } from '@nest-cloud/common';
import { FeishuAuthClientService } from './feishu-auth-client.service';
import { FeishuApiException, FeishuHttpClientService } from './feishu-http-client.service';
import type { FeishuApiResponse, FeishuWikiNode } from './feishu.types';

interface WikiNodeData {
  node?: FeishuWikiNode;
}

@Injectable()
export class FeishuWikiClientService {
  constructor(
    private readonly httpClient: FeishuHttpClientService,
    private readonly authClient: FeishuAuthClientService,
  ) {}

  async resolveSpreadsheet(wikiUrl: string): Promise<{ spreadsheetToken: string; title?: string }> {
    const nodeToken = extractWikiToken(wikiUrl);
    let refreshed = false;

    for (;;) {
      const accessToken = await this.authClient.getTenantAccessToken(refreshed);
      try {
        const payload = await this.httpClient.request<FeishuApiResponse<WikiNodeData>>({
          method: 'GET',
          path: '/open-apis/wiki/v2/spaces/get_node',
          accessToken,
          query: { token: nodeToken },
        });
        const node = payload.data?.node;
        if (node?.obj_type !== 'sheet') {
          throw new ParamsErrorException('飞书周报目标必须是电子表格 Sheet。');
        }
        const spreadsheetToken = node.obj_token?.trim();
        if (!spreadsheetToken) {
          throw new FeishuApiException('飞书 Sheet 节点缺少对象标识。', 502, false);
        }
        return { spreadsheetToken, title: node.title };
      } catch (error) {
        if (!refreshed && isUnauthorized(error)) {
          this.authClient.invalidate();
          refreshed = true;
          continue;
        }
        throw error;
      }
    }
  }
}

export function extractWikiToken(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ParamsErrorException('飞书 Wiki 地址格式无效。');
  }

  const hostname = url.hostname.toLowerCase();
  const allowed =
    hostname === 'feishu.cn' ||
    hostname.endsWith('.feishu.cn') ||
    hostname === 'larksuite.com' ||
    hostname.endsWith('.larksuite.com');
  const segments = url.pathname.split('/').filter(Boolean);
  if (!allowed || segments[0]?.toLowerCase() !== 'wiki' || !segments[1]) {
    throw new ParamsErrorException('飞书 Wiki 地址域名或路径不受支持。');
  }
  return segments[1];
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof FeishuApiException && error.getStatus() === 401;
}
