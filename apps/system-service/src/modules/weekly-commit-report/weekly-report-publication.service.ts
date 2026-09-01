import { Injectable } from '@nestjs/common';
import { getConfig, ParamsErrorException, ProjectException } from '@nest-cloud/common';
import {
  DEFAULT_FEISHU_MAX_RETRIES,
  DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
  FEISHU_DEFAULT_LOOKUP_RANGE,
  FEISHU_MAX_MONTHLY_TARGETS,
  WeeklyReportConfigKeys,
} from './weekly-report.constants';
import { FeishuSheetsClientService } from '../../client/feishu/feishu-sheets-client.service';
import { FeishuWikiClientService } from '../../client/feishu/feishu-wiki-client.service';
import { WeeklyReportSheetMapper } from './weekly-report-sheet-mapper';
import { findWeeklyReportTargetRow, normalizeCellText } from './weekly-report-target-resolver';
import type { FeishuMonthlyTarget, FeishuPublishSettings } from '../../client/feishu/feishu.types';
import type {
  WeeklyReportPublicationResult,
  WeeklyReportPublishInput,
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
    if (result.period !== 'last-week') {
      if (input?.enabled === true) {
        throw new ParamsErrorException('仅支持包含完整周一至周五摘要的上周周报发布。');
      }
      return null;
    }

    const settings = this.readSettings();
    const requested = input?.enabled === true || (input?.enabled === undefined && settings.enabled);
    if (!requested) return null;
    if (!settings.enabled) {
      throw new ProjectException('飞书周报发布功能未启用。', 503);
    }

    if (result.dailySections?.length !== 5) {
      throw new ParamsErrorException('仅支持包含完整周一至周五摘要的上周周报发布。');
    }

    const month = result.weekStart.slice(0, 7);
    const target = settings.targets.find((item) => item.month === month);
    if (!target) {
      throw new ParamsErrorException(`未配置 ${month} 对应的飞书 Sheet。`);
    }
    const person = this.resolvePerson(result, input, target);
    const { spreadsheetToken } = await this.wikiClient.resolveSpreadsheet(target.wikiUrl);
    const sheets = await this.sheetsClient.listSheets(spreadsheetToken);
    if (!sheets.some((sheet) => sheet.sheet_id === target.sheetId)) {
      throw new ParamsErrorException(`飞书 Sheet 不存在：${target.sheetId}。`);
    }

    const lookupRange = `${target.sheetId}!${target.lookupRange}`;
    const lookupValues = await this.sheetsClient.readValues(spreadsheetToken, lookupRange);
    const weekdayStart = result.dailySections[0].date;
    const weekdayEnd = result.dailySections[4].date;
    const targetRow = findWeeklyReportTargetRow(
      lookupValues,
      target.lookupRange,
      weekdayStart,
      weekdayEnd,
      person,
    );
    const targetRange = `${target.sheetId}!C${targetRow.row}:G${targetRow.row}`;
    const currentValues = await this.sheetsClient.readValues(spreadsheetToken, targetRange);
    const desiredValues = this.mapper.toWeekdayWrite(result, targetRow.row).values[0];
    if (sameCells(currentValues[0] ?? [], desiredValues)) {
      return {
        status: 'skipped',
        range: targetRange,
        row: targetRow.row,
        message: '目标单元格内容未变化，跳过写入。',
      };
    }

    await this.sheetsClient.updateValues(spreadsheetToken, targetRange, [desiredValues]);
    return {
      status: 'succeeded',
      range: targetRange,
      row: targetRow.row,
      message: '周一至周五摘要已写入飞书。',
    };
  }

  protected readSettings(): FeishuPublishSettings {
    const enabled = getConfig<boolean>(WeeklyReportConfigKeys.FeishuPublishEnabled, false, false);
    if (!enabled) {
      return {
        enabled: false,
        appId: '',
        appSecret: '',
        requestTimeoutMs: DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
        targets: [],
      };
    }

    const appId = getConfig<string>(WeeklyReportConfigKeys.FeishuAppId, '', false).trim();
    const appSecret = getConfig<string>(WeeklyReportConfigKeys.FeishuAppSecret, '', false).trim();
    const requestTimeoutMs = getConfig<number>(
      WeeklyReportConfigKeys.FeishuRequestTimeoutMs,
      DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
      false,
    );
    const maxRetries = getConfig<number>(
      WeeklyReportConfigKeys.FeishuMaxRetries,
      DEFAULT_FEISHU_MAX_RETRIES,
      false,
    );
    const rawTargets = getConfig<unknown>(
      WeeklyReportConfigKeys.FeishuMonthlyTargets,
      [],
      false,
      'json',
    );
    const targets = parseTargets(rawTargets);
    if (enabled && (!appId || !appSecret)) {
      throw new ProjectException('飞书周报发布缺少应用凭据。', 503);
    }
    return {
      enabled,
      appId,
      appSecret,
      requestTimeoutMs: validPositive(requestTimeoutMs, DEFAULT_FEISHU_REQUEST_TIMEOUT_MS),
      maxRetries: validNonNegativeInteger(maxRetries, DEFAULT_FEISHU_MAX_RETRIES),
      targets,
    };
  }

  private resolvePerson(
    result: WeeklyReportResult,
    input: WeeklyReportPublishInput | undefined,
    target: FeishuMonthlyTarget,
  ): string {
    const explicitPerson = input?.person?.trim() || target.name?.trim();
    if (explicitPerson) return explicitPerson;

    const people = [
      ...new Set(result.projects.map((project) => normalizeCellText(project.person))),
    ].filter(Boolean);
    if (people.length === 1) return people[0];
    throw new ParamsErrorException('无法唯一确定飞书表格 B 列中的姓名，请显式配置 person。');
  }
}

function parseTargets(value: unknown): FeishuMonthlyTarget[] {
  if (!Array.isArray(value)) {
    throw new ParamsErrorException('飞书月度 Sheet 配置必须是数组。');
  }
  if (value.length > FEISHU_MAX_MONTHLY_TARGETS) {
    throw new ParamsErrorException(
      `飞书月度 Sheet 配置最多支持 ${FEISHU_MAX_MONTHLY_TARGETS} 项。`,
    );
  }
  const targets = value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new ParamsErrorException(`飞书月度 Sheet 配置第 ${index + 1} 项无效。`);
    }
    const record = item as Record<string, unknown>;
    const month = String(record.month ?? '').trim();
    const wikiUrl = String(record.wikiUrl ?? '').trim();
    const sheetId = String(record.sheetId ?? '').trim();
    const lookupRange = String(record.lookupRange ?? FEISHU_DEFAULT_LOOKUP_RANGE).trim();
    const name = record.name === undefined ? undefined : String(record.name).trim();
    if (!/^\d{4}-\d{2}$/.test(month) || !wikiUrl || !sheetId || !/^A\d+:B\d+$/i.test(lookupRange)) {
      throw new ParamsErrorException(`飞书月度 Sheet 配置第 ${index + 1} 项字段无效。`);
    }
    return { month, wikiUrl, sheetId, lookupRange, name };
  });
  const months = new Set<string>();
  for (const target of targets) {
    if (months.has(target.month))
      throw new ParamsErrorException(`重复配置飞书月份：${target.month}。`);
    months.add(target.month);
  }
  return targets;
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
