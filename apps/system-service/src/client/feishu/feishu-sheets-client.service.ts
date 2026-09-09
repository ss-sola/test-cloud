import { Injectable } from '@nestjs/common';
import { FeishuAuthClientService } from './feishu-auth-client.service';
import { FeishuApiException, FeishuHttpClientService } from './feishu-http-client.service';
import type {
  FeishuApiResponse,
  FeishuRequestContext,
  FeishuSheetInfo,
  FeishuValueRange,
} from './feishu.types';

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

  async listSheets(
    spreadsheetToken: string,
    context: FeishuRequestContext,
  ): Promise<FeishuSheetInfo[]> {
    return this.withToken(async (accessToken) => {
      const payload = await this.httpClient.request<FeishuApiResponse<SheetsData>>(
        {
          method: 'GET',
          path: `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
          accessToken,
        },
        context,
      );
      return payload.data?.sheets ?? [];
    }, context);
  }

  async readValues(
    spreadsheetToken: string,
    range: string,
    context: FeishuRequestContext,
  ): Promise<unknown[][]> {
    return this.withToken(async (accessToken) => {
      const payload = await this.httpClient.request<FeishuApiResponse<SheetsData>>(
        {
          method: 'GET',
          path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`,
          accessToken,
        },
        context,
      );
      return payload.data?.valueRange?.values ?? [];
    }, context);
  }

  async updateValues(
    spreadsheetToken: string,
    range: string,
    values: unknown[][],
    context: FeishuRequestContext,
  ): Promise<void> {
    await this.withToken(async (accessToken) => {
      await this.httpClient.request<FeishuApiResponse>(
        {
          method: 'PUT',
          path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`,
          accessToken,
          body: {
            valueRange: { range, values },
          },
        },
        context,
      );
    }, context);
  }

  private async withToken<T>(
    operation: (accessToken: string) => Promise<T>,
    context: FeishuRequestContext,
  ): Promise<T> {
    let refreshed = false;
    for (;;) {
      const accessToken = await this.authClient.getTenantAccessToken(refreshed, context);
      try {
        return await operation(accessToken);
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

function isUnauthorized(error: unknown): boolean {
  return error instanceof FeishuApiException && error.getStatus() === 401;
}
