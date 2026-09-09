import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ProjectException } from '@nest-cloud/common';
import { FEISHU_TOKEN_REFRESH_SKEW_MS } from '../../modules/weekly-commit-report/weekly-report.constants';
import { FeishuHttpClientService } from './feishu-http-client.service';
import type { FeishuApiResponse, FeishuRequestContext } from './feishu.types';

interface TenantTokenResponse extends FeishuApiResponse {
  tenant_access_token?: string;
  expire?: number;
}

@Injectable()
export class FeishuAuthClientService {
  private readonly cachedTokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly refreshPromises = new Map<string, Promise<string>>();

  constructor(private readonly httpClient: FeishuHttpClientService) {}

  async getTenantAccessToken(forceRefresh = false, context: FeishuRequestContext): Promise<string> {
    const credentials = this.resolveCredentials(context);
    const cacheKey = this.getCacheKey(credentials);
    const cachedToken = this.cachedTokens.get(cacheKey);
    if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.value;
    }

    const pendingRefresh = this.refreshPromises.get(cacheKey);
    if (pendingRefresh) return pendingRefresh;

    const refresh = this.requestToken(credentials.appId, credentials.appSecret, context);
    this.refreshPromises.set(cacheKey, refresh);
    try {
      return await refresh;
    } finally {
      if (this.refreshPromises.get(cacheKey) === refresh) this.refreshPromises.delete(cacheKey);
    }
  }

  invalidate(context?: FeishuRequestContext): void {
    if (context) this.cachedTokens.delete(this.getCacheKey(context));
    else this.cachedTokens.clear();
  }

  private async requestToken(
    appId: string,
    appSecret: string,
    context: FeishuRequestContext,
  ): Promise<string> {
    const payload = await this.httpClient.request<TenantTokenResponse>(
      {
        method: 'POST',
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        body: { app_id: appId, app_secret: appSecret },
      },
      context,
    );
    const token = payload.tenant_access_token?.trim();
    if (!token || !payload.expire || payload.expire <= 0) {
      throw new ProjectException('飞书应用凭据无效或未返回有效令牌。', 503);
    }

    this.cachedTokens.set(this.getCacheKey({ appId, appSecret }), {
      value: token,
      expiresAt: Date.now() + Math.max(1, payload.expire) * 1000 - FEISHU_TOKEN_REFRESH_SKEW_MS,
    });
    return token;
  }

  private resolveCredentials(context: FeishuRequestContext): FeishuRequestContext {
    if (!context.appId.trim() || !context.appSecret.trim()) {
      throw new ProjectException('未配置飞书应用凭据，无法发布周报。', 503);
    }
    return context;
  }

  private getCacheKey(context: Pick<FeishuRequestContext, 'appId' | 'appSecret'>): string {
    return createHash('sha256')
      .update(JSON.stringify([context.appId, context.appSecret]))
      .digest('hex');
  }
}
