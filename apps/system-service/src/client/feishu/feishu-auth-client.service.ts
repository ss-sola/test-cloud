import { Injectable } from '@nestjs/common';
import { getConfig, ProjectException } from '@nest-cloud/common';
import {
  FEISHU_TOKEN_REFRESH_SKEW_MS,
  WeeklyReportConfigKeys,
} from '../../modules/weekly-commit-report/weekly-report.constants';
import { FeishuHttpClientService } from './feishu-http-client.service';
import type { FeishuApiResponse } from './feishu.types';

interface TenantTokenResponse extends FeishuApiResponse {
  tenant_access_token?: string;
  expire?: number;
}

@Injectable()
export class FeishuAuthClientService {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(private readonly httpClient: FeishuHttpClientService) {}

  async getTenantAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value;
    }
    if (this.refreshPromise) return this.refreshPromise;

    const appId = getConfig<string>(WeeklyReportConfigKeys.FeishuAppId, '', false).trim();
    const appSecret = getConfig<string>(WeeklyReportConfigKeys.FeishuAppSecret, '', false).trim();
    if (!appId || !appSecret) {
      throw new ProjectException('未配置飞书应用凭据，无法发布周报。', 503);
    }

    this.refreshPromise = this.requestToken(appId, appSecret);
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  invalidate(): void {
    this.cachedToken = null;
  }

  private async requestToken(appId: string, appSecret: string): Promise<string> {
    const payload = await this.httpClient.request<TenantTokenResponse>({
      method: 'POST',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      body: { app_id: appId, app_secret: appSecret },
    });
    const token = payload.tenant_access_token?.trim();
    if (!token || !payload.expire || payload.expire <= 0) {
      throw new ProjectException('飞书应用凭据无效或未返回有效令牌。', 503);
    }

    this.cachedToken = {
      value: token,
      expiresAt: Date.now() + Math.max(1, payload.expire) * 1000 - FEISHU_TOKEN_REFRESH_SKEW_MS,
    };
    return token;
  }
}
