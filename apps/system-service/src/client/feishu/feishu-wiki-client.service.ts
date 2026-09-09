import { Injectable } from '@nestjs/common';
import { ParamsErrorException } from '@nest-cloud/common';
import { FeishuAuthClientService } from './feishu-auth-client.service';
import { FeishuApiException, FeishuHttpClientService } from './feishu-http-client.service';
import type { FeishuApiResponse, FeishuRequestContext, FeishuWikiNode } from './feishu.types';

interface WikiNodeData {
  node?: FeishuWikiNode;
}

@Injectable()
export class FeishuWikiClientService {
  constructor(
    private readonly httpClient: FeishuHttpClientService,
    private readonly authClient: FeishuAuthClientService,
  ) {}

  async resolveSpreadsheet(
    wikiUrl: string,
    context: FeishuRequestContext,
  ): Promise<{ spreadsheetToken: string; sheetId?: string; title?: string }> {
    const resource = parseFeishuResourceUrl(wikiUrl);
    if (resource.type === 'sheet') {
      return { spreadsheetToken: resource.token, sheetId: resource.sheetId };
    }

    const nodeToken = resource.token;
    let refreshed = false;

    for (;;) {
      const accessToken = await this.authClient.getTenantAccessToken(refreshed, context);
      try {
        const payload = await this.httpClient.request<FeishuApiResponse<WikiNodeData>>(
          {
            method: 'GET',
            path: '/open-apis/wiki/v2/spaces/get_node',
            accessToken,
            query: { token: nodeToken },
          },
          context,
        );
        const node = payload.data?.node;
        if (node?.obj_type !== 'sheet') {
          throw new ParamsErrorException('飞书周报目标必须是电子表格 Sheet。');
        }
        const spreadsheetToken = node.obj_token?.trim();
        if (!spreadsheetToken) {
          throw new FeishuApiException('飞书 Sheet 节点缺少对象标识。', 502, false);
        }
        return { spreadsheetToken, sheetId: resource.sheetId, title: node.title };
      } catch (error) {
        if (!refreshed && isUnauthorized(error)) {
          this.authClient.invalidate(context);
          refreshed = true;
          continue;
        }
        throw error;
      }
    }
  }
}

interface FeishuResourceUrl {
  type: 'wiki' | 'sheet';
  token: string;
  sheetId?: string;
}

function parseFeishuResourceUrl(value: string): FeishuResourceUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ParamsErrorException('飞书 Wiki 或 Sheet 地址格式无效。');
  }

  const hostname = url.hostname.toLowerCase();
  const allowed =
    hostname === 'feishu.cn' ||
    hostname.endsWith('.feishu.cn') ||
    hostname === 'larksuite.com' ||
    hostname.endsWith('.larksuite.com');
  const segments = url.pathname.split('/').filter(Boolean);
  const type = segments[0]?.toLowerCase();
  if (!allowed || (type !== 'wiki' && type !== 'sheets') || !segments[1]) {
    throw new ParamsErrorException('飞书 Wiki 或 Sheet 地址域名或路径不受支持。');
  }
  const sheetId = url.searchParams.get('sheet')?.trim() || undefined;
  if (
    sheetId &&
    [...sheetId].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new ParamsErrorException('飞书 Sheet 地址中的 sheet 参数无效。');
  }
  return { type: type === 'wiki' ? 'wiki' : 'sheet', token: segments[1], sheetId };
}

export function extractWikiToken(value: string): string {
  const resource = parseFeishuResourceUrl(value);
  if (resource.type !== 'wiki') {
    throw new ParamsErrorException('飞书 Wiki 地址域名或路径不受支持。');
  }
  return resource.token;
}

export function extractSheetToken(value: string): string {
  const resource = parseFeishuResourceUrl(value);
  if (resource.type !== 'sheet') {
    throw new ParamsErrorException('飞书 Sheet 地址域名或路径不受支持。');
  }
  return resource.token;
}

export function extractSheetId(value: string): string | undefined {
  return parseFeishuResourceUrl(value).sheetId;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof FeishuApiException && error.getStatus() === 401;
}
