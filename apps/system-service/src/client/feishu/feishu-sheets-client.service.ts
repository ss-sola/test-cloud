import { Injectable } from '@nestjs/common';
import { FeishuAuthClientService } from './feishu-auth-client.service';
import { FeishuApiException, FeishuHttpClientService } from './feishu-http-client.service';
import type { FeishuApiResponse, FeishuSheetInfo, FeishuValueRange } from './feishu.types';

interface SheetsData {
  sheets?: FeishuSheetInfo[];
  valueRange?: FeishuValueRange;
}

@Injectable()
export class FeishuSheetsClientService {
  constructor(
    private readonly httpClient: FeishuHttpClientService,
    private readonly authClient: FeishuAuthClientService,
  ) {}

  async listSheets(spreadsheetToken: string): Promise<FeishuSheetInfo[]> {
    return this.withToken(async (accessToken) => {
      const payload = await this.httpClient.request<FeishuApiResponse<SheetsData>>({
        method: 'GET',
        path: `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
        accessToken,
      });
      return payload.data?.sheets ?? [];
    });
  }

  async readValues(spreadsheetToken: string, range: string): Promise<unknown[][]> {
    return this.withToken(async (accessToken) => {
      const payload = await this.httpClient.request<FeishuApiResponse<SheetsData>>({
        method: 'GET',
        path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`,
        accessToken,
      });
      return payload.data?.valueRange?.values ?? [];
    });
  }

  async updateValues(spreadsheetToken: string, range: string, values: unknown[][]): Promise<void> {
    await this.withToken(async (accessToken) => {
      await this.httpClient.request<FeishuApiResponse>({
        method: 'PUT',
        path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`,
        accessToken,
        body: {
          valueRange: { range, values },
        },
      });
    });
  }

  private async withToken<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    let refreshed = false;
    for (;;) {
      const accessToken = await this.authClient.getTenantAccessToken(refreshed);
      try {
        return await operation(accessToken);
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

function isUnauthorized(error: unknown): boolean {
  return error instanceof FeishuApiException && error.getStatus() === 401;
}
