import { Injectable } from '@nestjs/common';
import {
  WORKFLOW_CAPABILITY_HOSTS,
  WORKFLOW_CAPABILITY_LIMITS,
} from '../../constants/workflow-capability.constants';
import { WorkflowCapabilityException } from '../../modules/workflow-capabilities/workflow-capability.exception';
import { ExternalHttpClientService } from '../external/external-http-client.service';
import { parseFeishuSheetUrl } from './feishu-sheet-url.util';

export interface FeishuSheetTarget {
  accessToken: string;
  spreadsheetToken: string;
  sheetId: string;
}

export interface FeishuTargetRequest {
  wikiUrl: string;
  appId: string;
  appSecret: string;
  signal: AbortSignal;
}

export interface FeishuWriteRequest {
  target: FeishuSheetTarget;
  range: string;
  values: Array<Array<string | number | boolean>>;
  signal: AbortSignal;
}

/** 飞书合并单元格区域：下标从 0 开始，行列为数量。 */
export interface FeishuMergeRange {
  startRowIndex: number;
  startColumnIndex: number;
  rowCount: number;
  columnCount: number;
}

interface FeishuCallOptions {
  stage: string;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  query?: Record<string, string>;
  accessToken?: string;
  body?: unknown;
  signal: AbortSignal;
}

interface FeishuEnvelope {
  code?: unknown;
  tenant_access_token?: unknown;
  data?: {
    node?: { obj_type?: unknown; obj_token?: unknown };
    valueRange?: { values?: unknown };
    sheets?: unknown;
  };
}

/**
 * 固定访问 open.feishu.cn 的受控表格网关：每次调用自行换取 tenant token（不缓存），
 * 通过 open.feishu.cn 域名直接发送 HTTPS 请求，读取与写入各只发一次请求，不自动重试。
 * 异常只保留阶段、HTTP 状态和飞书数字错误码，不包含凭据、请求体或上游文本。
 */
@Injectable()
export class FeishuSheetGatewayService {
  constructor(private readonly transport: ExternalHttpClientService) {}

  /** 解析飞书表格地址并换取访问令牌；Wiki 地址会先解析为底层电子表格。 */
  async resolveTarget(options: FeishuTargetRequest): Promise<FeishuSheetTarget> {
    const locator = parseFeishuSheetUrl(options.wikiUrl);
    const tokenPayload = await this.call({
      stage: '获取访问令牌',
      method: 'POST',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      body: { app_id: options.appId, app_secret: options.appSecret },
      signal: options.signal,
    });
    const accessToken =
      typeof tokenPayload.tenant_access_token === 'string' ? tokenPayload.tenant_access_token : '';
    if (!accessToken) {
      throw new WorkflowCapabilityException('飞书应用凭据无效或未返回访问令牌。', 502);
    }

    if (locator.type === 'sheets') {
      return { accessToken, spreadsheetToken: locator.token, sheetId: locator.sheetId };
    }
    const nodePayload = await this.call({
      stage: '解析 Wiki 节点',
      method: 'GET',
      path: '/open-apis/wiki/v2/spaces/get_node',
      query: { token: locator.token },
      accessToken,
      signal: options.signal,
    });
    const node = nodePayload.data?.node;
    if (node?.obj_type !== 'sheet' || typeof node.obj_token !== 'string' || !node.obj_token) {
      throw new WorkflowCapabilityException('飞书 Wiki 节点不是电子表格。', 400);
    }
    return { accessToken, spreadsheetToken: node.obj_token, sheetId: locator.sheetId };
  }

  /** 读取指定范围的单元格文本值（ToString 渲染），尾部空单元格可能被飞书省略。 */
  async readValues(
    target: FeishuSheetTarget,
    range: string,
    signal: AbortSignal,
  ): Promise<unknown[][]> {
    const payload = await this.call({
      stage: '读取表格范围',
      method: 'GET',
      path: `${this.valuesPath(target)}/${encodeURIComponent(`${target.sheetId}!${range}`)}`,
      query: { valueRenderOption: 'ToString', dateTimeRenderOption: 'FormattedString' },
      accessToken: target.accessToken,
      signal,
    });
    const values = payload.data?.valueRange?.values;
    if (values === undefined || values === null) return [];
    if (!Array.isArray(values) || !values.every((row) => Array.isArray(row))) {
      throw new WorkflowCapabilityException('飞书表格响应格式无效。', 502);
    }
    return values as unknown[][];
  }

  /** 读取链接指定工作表的合并单元格区域；工作表不存在或区域格式无效时明确失败。 */
  async readMerges(target: FeishuSheetTarget, signal: AbortSignal): Promise<FeishuMergeRange[]> {
    const payload = await this.call({
      stage: '读取合并单元格',
      method: 'GET',
      path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(target.spreadsheetToken)}/metainfo`,
      accessToken: target.accessToken,
      signal,
    });
    const sheets = payload.data?.sheets;
    const sheet = Array.isArray(sheets)
      ? (sheets as Array<{ sheetId?: unknown; merges?: unknown }>).find(
          (item) => item?.sheetId === target.sheetId,
        )
      : undefined;
    if (!sheet) throw new WorkflowCapabilityException('飞书表格中不存在链接指定的工作表。', 400);
    const merges = sheet.merges ?? [];
    const valid =
      Array.isArray(merges) &&
      merges.every(
        (merge: Record<string, unknown>) =>
          Number.isSafeInteger(merge?.startRowIndex) &&
          Number.isSafeInteger(merge?.startColumnIndex) &&
          Number.isSafeInteger(merge?.rowCount) &&
          Number.isSafeInteger(merge?.columnCount) &&
          (merge.startRowIndex as number) >= 0 &&
          (merge.startColumnIndex as number) >= 0 &&
          (merge.rowCount as number) >= 1 &&
          (merge.columnCount as number) >= 1,
      );
    if (!valid) throw new WorkflowCapabilityException('飞书合并单元格响应格式无效。', 502);
    return (merges as FeishuMergeRange[]).map(
      ({ startRowIndex, startColumnIndex, rowCount, columnCount }) => ({
        startRowIndex,
        startColumnIndex,
        rowCount,
        columnCount,
      }),
    );
  }

  /** 单次写入矩阵；不重试。 */
  async writeValues(request: FeishuWriteRequest): Promise<void> {
    await this.call({
      stage: '写入表格范围',
      method: 'PUT',
      path: this.valuesPath(request.target),
      accessToken: request.target.accessToken,
      body: {
        valueRange: {
          range: `${request.target.sheetId}!${request.range}`,
          values: request.values,
        },
      },
      signal: request.signal,
    });
  }

  private valuesPath(target: FeishuSheetTarget): string {
    return `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(target.spreadsheetToken)}/values`;
  }

  /** 发送一次飞书请求并校验 HTTP 与业务状态码。 */
  private async call(options: FeishuCallOptions): Promise<FeishuEnvelope> {
    const url = new URL(`https://${WORKFLOW_CAPABILITY_HOSTS.feishu}${options.path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

    const response = await this.transport.request({
      url,
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      timeoutMs: WORKFLOW_CAPABILITY_LIMITS.feishuRequestTimeoutMs,
      maxResponseBytes: WORKFLOW_CAPABILITY_LIMITS.maxUpstreamResponseBytes,
      signal: options.signal,
    });

    let payload: FeishuEnvelope | undefined;
    try {
      payload = JSON.parse(response.body) as FeishuEnvelope;
    } catch {
      payload = undefined;
    }
    const code = typeof payload?.code === 'number' && payload.code !== 0 ? payload.code : undefined;
    if (response.status < 200 || response.status >= 300 || code !== undefined) {
      const status = response.status === 429 ? 429 : 502;
      throw new WorkflowCapabilityException(
        `飞书接口调用失败（${options.stage}，HTTP ${response.status}${code === undefined ? '' : `，错误码 ${code}`}）。`,
        status,
      );
    }
    if (!payload || typeof payload !== 'object') {
      throw new WorkflowCapabilityException(`飞书响应格式无效（${options.stage}）。`, 502);
    }
    return payload;
  }
}
