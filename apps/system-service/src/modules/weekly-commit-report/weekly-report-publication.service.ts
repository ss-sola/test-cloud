import { Injectable } from '@nestjs/common';
import { ParamsErrorException } from '@nest-cloud/common';
import {
  DEFAULT_FEISHU_MAX_RETRIES,
  DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
  FEISHU_DEFAULT_LOOKUP_RANGE,
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
    if (!input || input.enabled === false) return null;

    if (result.period !== 'last-week') {
      throw new ParamsErrorException('仅支持包含完整周一至周五摘要的上周周报发布。');
    }
    const settings = this.readSettings(input.settings);
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
    if (!input) throw new ParamsErrorException('飞书周报发布缺少请求级配置。');
    const target = parsePublishTarget(input);
    return {
      enabled: true,
      appId: input.appId.trim(),
      appSecret: input.appSecret.trim(),
      requestTimeoutMs: input.requestTimeoutMs ?? DEFAULT_FEISHU_REQUEST_TIMEOUT_MS,
      maxRetries: input.maxRetries ?? DEFAULT_FEISHU_MAX_RETRIES,
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

function parsePublishTarget(
  value: Pick<WeeklyReportPublishSettingsInput, 'wikiUrl' | 'name'>,
): Pick<FeishuPublishSettings, 'wikiUrl' | 'name'> {
  return {
    wikiUrl: value.wikiUrl.trim(),
    name: value.name?.trim() || undefined,
  };
}

function sameCells(current: unknown[], desired: string[]): boolean {
  if (current.length !== desired.length) return false;
  return desired.every((value, index) => normalizePublishedText(current[index]) === value);
}

function normalizePublishedText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r\n/g, '\n').trim();
}
