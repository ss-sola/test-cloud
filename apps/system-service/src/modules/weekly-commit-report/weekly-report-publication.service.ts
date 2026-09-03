import { Injectable } from '@nestjs/common';
import { getConfig, ParamsErrorException, ProjectException } from '@nest-cloud/common';
import {
  DEFAULT_FEISHU_MAX_RETRIES,
  DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
  FEISHU_DEFAULT_LOOKUP_RANGE,
  WeeklyReportConfigKeys,
} from './weekly-report.constants';
import { FeishuSheetsClientService } from '../../client/feishu/feishu-sheets-client.service';
import { FeishuWikiClientService } from '../../client/feishu/feishu-wiki-client.service';
import { WeeklyReportSheetMapper } from './weekly-report-sheet-mapper';
import { findWeeklyReportTargetRow, normalizeCellText } from './weekly-report-target-resolver';
import type { FeishuPublishSettings, FeishuRequestContext } from '../../client/feishu/feishu.types';
import type {
  WeeklyReportPublicationResult,
  WeeklyReportPublishInput,
  WeeklyReportPublishSettingsInput,
  WeeklyReportResult,
} from './weekly-report.types';

@Injectable()
export class WeeklyReportPublicationService {
  constructor(
    private readonly wikiClient: FeishuWikiClientService,
    private readonly sheetsClient: FeishuSheetsClientService,
    private readonly mapper: WeeklyReportSheetMapper,
  ) {}

  async publishIfEnabled(
    result: WeeklyReportResult,
    input?: WeeklyReportPublishInput,
  ): Promise<WeeklyReportPublicationResult | null> {
    if (input?.enabled === false) return null;

    if (result.period !== 'last-week') {
      if (input?.enabled === true) {
        throw new ParamsErrorException('仅支持包含完整周一至周五摘要的上周周报发布。');
      }
      return null;
    }

    const settings = this.readSettings(input?.settings);
    const requested = input?.enabled === true || (input?.enabled === undefined && settings.enabled);
    if (!requested) return null;
    if (!settings.enabled) {
      throw new ProjectException('飞书周报发布功能未启用。', 503);
    }

    if (result.dailySections?.length !== 5) {
      throw new ParamsErrorException('仅支持包含完整周一至周五摘要的上周周报发布。');
    }

    const person = this.resolvePerson(result, input, settings.name);
    const context: FeishuRequestContext = {
      appId: settings.appId,
      appSecret: settings.appSecret,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxRetries: settings.maxRetries,
    };
    const { spreadsheetToken, sheetId } = await this.wikiClient.resolveSpreadsheet(
      settings.wikiUrl,
      context,
    );
    if (!sheetId) {
      throw new ParamsErrorException('飞书 Sheet 地址缺少 sheet 参数。');
    }
    const sheets = await this.sheetsClient.listSheets(spreadsheetToken, context);
    if (!sheets.some((sheet) => sheet.sheet_id === sheetId)) {
      throw new ParamsErrorException(`飞书 Sheet 不存在：${sheetId}。`);
    }

    const lookupRange = `${sheetId}!${FEISHU_DEFAULT_LOOKUP_RANGE}`;
    const lookupValues = await this.sheetsClient.readValues(spreadsheetToken, lookupRange, context);
    const weekdayStart = result.dailySections[0].date;
    const weekdayEnd = result.dailySections[4].date;
    const targetRow = findWeeklyReportTargetRow(
      lookupValues,
      FEISHU_DEFAULT_LOOKUP_RANGE,
      weekdayStart,
      weekdayEnd,
      person,
    );
    const targetRange = `${sheetId}!C${targetRow.row}:G${targetRow.row}`;
    const currentValues = await this.sheetsClient.readValues(
      spreadsheetToken,
      targetRange,
      context,
    );
    const desiredValues = this.mapper.toWeekdayWrite(result, targetRow.row).values[0];
    if (sameCells(currentValues[0] ?? [], desiredValues)) {
      return {
        status: 'skipped',
        range: targetRange,
        row: targetRow.row,
        message: '目标单元格内容未变化，跳过写入。',
      };
    }

    await this.sheetsClient.updateValues(spreadsheetToken, targetRange, [desiredValues], context);
    return {
      status: 'succeeded',
      range: targetRange,
      row: targetRow.row,
      message: '周一至周五摘要已写入飞书。',
    };
  }

  protected readSettings(input?: WeeklyReportPublishSettingsInput): FeishuPublishSettings {
    if (input) {
      const appId = readCredential(
        input.appId,
        WeeklyReportConfigKeys.FeishuCliAppId,
        WeeklyReportConfigKeys.FeishuAppId,
      );
      const appSecret = readCredential(
        input.appSecret,
        WeeklyReportConfigKeys.FeishuCliAppSecret,
        WeeklyReportConfigKeys.FeishuAppSecret,
      );
      if (!appId || !appSecret) {
        throw new ProjectException('飞书周报发布缺少应用凭据。', 503);
      }
      const target = parsePublishTarget(input);
      return {
        enabled: true,
        appId,
        appSecret,
        requestTimeoutMs: readRequestTimeout(),
        maxRetries: readMaxRetries(),
        ...target,
      };
    }

    const enabled = getConfig<boolean>(WeeklyReportConfigKeys.FeishuPublishEnabled, false, false);
    if (!enabled) {
      return {
        enabled: false,
        appId: '',
        appSecret: '',
        requestTimeoutMs: DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
        wikiUrl: '',
      };
    }

    const appId = readCredential(
      undefined,
      WeeklyReportConfigKeys.FeishuCliAppId,
      WeeklyReportConfigKeys.FeishuAppId,
    );
    const appSecret = readCredential(
      undefined,
      WeeklyReportConfigKeys.FeishuCliAppSecret,
      WeeklyReportConfigKeys.FeishuAppSecret,
    );
    const requestTimeoutMs = readRequestTimeout();
    const maxRetries = readMaxRetries();
    const configuredTarget = getConfig<unknown>(
      WeeklyReportConfigKeys.FeishuTarget,
      null,
      false,
      'json',
    );
    const legacyTarget =
      configuredTarget == null
        ? getConfig<unknown>(WeeklyReportConfigKeys.FeishuMonthlyTargets, null, false, 'json')
        : null;
    const target = parsePublishTarget(configuredTarget ?? legacyTarget);
    if (!appId || !appSecret) {
      throw new ProjectException('飞书周报发布缺少应用凭据。', 503);
    }
    return {
      enabled,
      appId,
      appSecret,
      requestTimeoutMs: validPositive(requestTimeoutMs, DEFAULT_FEISHU_REQUEST_TIMEOUT_MS),
      maxRetries: validNonNegativeInteger(maxRetries, DEFAULT_FEISHU_MAX_RETRIES),
      ...target,
    };
  }

  private resolvePerson(
    result: WeeklyReportResult,
    input: WeeklyReportPublishInput | undefined,
    configuredName?: string,
  ): string {
    const explicitPerson = input?.person?.trim() || configuredName?.trim();
    if (explicitPerson) return explicitPerson;

    const people = [
      ...new Set(result.projects.map((project) => normalizeCellText(project.person))),
    ].filter(Boolean);
    if (people.length === 1) return people[0];
    throw new ParamsErrorException('无法唯一确定飞书表格 B 列中的姓名，请显式配置 person。');
  }
}

function readCredential(value: unknown, primaryKey: string, fallbackKey: string): string {
  const requested = String(value ?? '').trim();
  if (requested) return requested;
  const environmentValue = getConfig<string>(primaryKey, '', false).trim();
  if (environmentValue) return environmentValue;
  return getConfig<string>(fallbackKey, '', false).trim();
}

function readRequestTimeout(): number {
  return validPositive(
    getConfig<number>(
      WeeklyReportConfigKeys.FeishuRequestTimeoutMs,
      DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
      false,
    ),
    DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
  );
}

function readMaxRetries(): number {
  return validNonNegativeInteger(
    getConfig<number>(WeeklyReportConfigKeys.FeishuMaxRetries, DEFAULT_FEISHU_MAX_RETRIES, false),
    DEFAULT_FEISHU_MAX_RETRIES,
  );
}

function parsePublishTarget(value: unknown): Pick<FeishuPublishSettings, 'wikiUrl' | 'name'> {
  let targetValue = value;
  if (Array.isArray(targetValue)) {
    if (targetValue.length !== 1) {
      throw new ParamsErrorException(
        '旧版飞书月度目标配置无法自动迁移，请改为配置单个 Wiki 地址。',
      );
    }
    targetValue = targetValue[0];
  }
  if (!targetValue || typeof targetValue !== 'object') {
    throw new ParamsErrorException('飞书周报发布缺少 Wiki 地址。');
  }

  const record = targetValue as Record<string, unknown>;
  const wikiUrl = String(record.wikiUrl ?? '').trim();
  if (!wikiUrl) {
    throw new ParamsErrorException('飞书周报发布缺少 Wiki 地址。');
  }
  const name = record.name === undefined ? undefined : String(record.name).trim() || undefined;
  return {
    wikiUrl: addLegacySheetId(wikiUrl, record.sheetId),
    name,
  };
}

function addLegacySheetId(wikiUrl: string, sheetId: unknown): string {
  const legacySheetId = String(sheetId ?? '').trim();
  if (!legacySheetId) return wikiUrl;
  try {
    const url = new URL(wikiUrl);
    if (url.searchParams.get('sheet')?.trim()) return wikiUrl;
    url.searchParams.set('sheet', legacySheetId);
    return url.toString();
  } catch {
    return wikiUrl;
  }
}

function sameCells(current: unknown[], desired: string[]): boolean {
  if (current.length !== desired.length) return false;
  return desired.every((value, index) => normalizePublishedText(current[index]) === value);
}

function normalizePublishedText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r\n/g, '\n').trim();
}

function validPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function validNonNegativeInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
