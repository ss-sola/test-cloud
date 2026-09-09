import { describe, expect, it, vi } from 'vitest';
import { WeeklyReportPublicationService } from '../modules/weekly-commit-report/weekly-report-publication.service';
import { WeeklyReportSheetMapper } from '../modules/weekly-commit-report/weekly-report-sheet-mapper';
import type { FeishuPublishSettings } from '../client/feishu/feishu.types';
import type {
  WeeklyReportPublishSettingsInput,
  WeeklyReportResult,
} from '../modules/weekly-commit-report/weekly-report.types';

const result: WeeklyReportResult = {
  period: 'last-week',
  weekStart: '2026-08-24',
  weekEnd: '2026-08-30',
  markdown: '# report\n',
  projects: [
    {
      repo: 'https://github.com/example/report.git',
      repoLabel: 'report',
      person: '张三',
      branch: 'main',
      commitCount: 1,
      bullets: ['完成接口'],
    },
  ],
  projectErrors: [],
  commitCount: 1,
  degraded: false,
  dailySections: [
    { date: '2026-08-24', logs: [], bullets: ['完成接口'] },
    { date: '2026-08-25', logs: [], bullets: ['补充测试'] },
    { date: '2026-08-26', logs: [], bullets: ['整理文档'] },
    { date: '2026-08-27', logs: [], bullets: ['修复导出'] },
    { date: '2026-08-28', logs: [], bullets: ['发布验证'] },
  ],
};

class TestPublicationService extends WeeklyReportPublicationService {
  protected override readSettings(input?: WeeklyReportPublishSettingsInput): FeishuPublishSettings {
    if (input) return super.readSettings(input);
    return {
      enabled: true,
      appId: 'app-id',
      appSecret: 'app-secret',
      requestTimeoutMs: 15_000,
      maxRetries: 2,
      wikiUrl: 'https://tthdtech.feishu.cn/wiki/wiki-token?sheet=sheet-august',
      name: '张三',
    };
  }

  readSettingsForTest(input?: WeeklyReportPublishSettingsInput): FeishuPublishSettings {
    return super.readSettings(input);
  }
}

function createService(lookupValues: unknown[][], currentValues: unknown[][]) {
  const wikiClient = {
    resolveSpreadsheet: vi.fn().mockResolvedValue({
      spreadsheetToken: 'spreadsheet-token',
      sheetId: 'sheet-august',
    }),
  };
  const sheetsClient = {
    listSheets: vi.fn().mockResolvedValue([{ sheet_id: 'sheet-august' }]),
    readValues: vi.fn().mockResolvedValueOnce(lookupValues).mockResolvedValueOnce(currentValues),
    updateValues: vi.fn().mockResolvedValue(undefined),
  };
  const service = new TestPublicationService(
    wikiClient as never,
    sheetsClient as never,
    new WeeklyReportSheetMapper(),
  );
  return { service, sheetsClient, wikiClient };
}

describe('WeeklyReportPublicationService', () => {
  it('does not read or publish when synchronization is explicitly disabled', async () => {
    const { service, sheetsClient } = createService([], []);

    await expect(service.publishIfEnabled(result, { enabled: false })).resolves.toBeNull();
    expect(sheetsClient.listSheets).not.toHaveBeenCalled();
    expect(sheetsClient.readValues).not.toHaveBeenCalled();
    expect(sheetsClient.updateValues).not.toHaveBeenCalled();
  });

  it('skips when the five target cells already contain the same values', async () => {
    const expected = new WeeklyReportSheetMapper().toWeekdayWrite(result, 2).values[0];
    const { service, sheetsClient } = createService(
      [
        ['8.24-8.28', '李四'],
        ['8.24-8.28', '张三'],
      ],
      [expected],
    );

    const publication = await service.publishIfEnabled(result, { person: '张三' });

    expect(publication).toMatchObject({ status: 'skipped', row: 2, range: 'sheet-august!C2:G2' });
    expect(sheetsClient.updateValues).not.toHaveBeenCalled();
  });

  it('uses the flat request-level Wiki and name settings', async () => {
    const { service, sheetsClient, wikiClient } = createService(
      [['8.24-8.28', '张三']],
      [['旧内容', '保留', '不变', '旧内容', '旧内容']],
    );
    const settings: WeeklyReportPublishSettingsInput = {
      appId: 'request-app-id',
      appSecret: 'request-app-secret',
      wikiUrl: 'https://tthdtech.feishu.cn/wiki/request-wiki-token?sheet=sheet-august',
      name: '张三',
    };

    await service.publishIfEnabled(result, { enabled: true, settings });

    expect(wikiClient.resolveSpreadsheet).toHaveBeenCalledWith(
      settings.wikiUrl,
      expect.objectContaining({
        appId: settings.appId,
        appSecret: settings.appSecret,
      }),
    );
    expect(sheetsClient.readValues).toHaveBeenNthCalledWith(
      1,
      'spreadsheet-token',
      'sheet-august!A1:B200',
      expect.anything(),
    );
    expect(sheetsClient.updateValues).toHaveBeenCalledWith(
      'spreadsheet-token',
      'sheet-august!C1:G1',
      [['1. 完成接口', '1. 补充测试', '1. 整理文档', '1. 修复导出', '1. 发布验证']],
      expect.objectContaining({ appId: settings.appId, appSecret: settings.appSecret }),
    );
  });

  it('rejects missing request-level publication settings', () => {
    const { service } = createService([], []);
    expect(() => service.readSettingsForTest()).toThrow(/请求级配置/);
  });

  it('does not migrate legacy target configuration', () => {
    const { service } = createService([], []);
    expect(() => service.readSettingsForTest()).toThrow(/请求级配置/);
  });

  it('uses the configured Wiki when the report week crosses a month boundary', async () => {
    const crossMonthResult: WeeklyReportResult = {
      ...result,
      weekStart: '2026-08-31',
      weekEnd: '2026-09-06',
      dailySections: result.dailySections?.map((section, index) => ({
        ...section,
        date: ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'][index],
      })),
    };
    const { service, wikiClient, sheetsClient } = createService(
      [['8.31-9.04', '张三']],
      [['旧内容', '旧内容', '旧内容', '旧内容', '旧内容']],
    );

    await service.publishIfEnabled(crossMonthResult, { person: '张三' });

    expect(wikiClient.resolveSpreadsheet).toHaveBeenCalledWith(
      'https://tthdtech.feishu.cn/wiki/wiki-token?sheet=sheet-august',
      expect.anything(),
    );
    expect(sheetsClient.readValues).toHaveBeenNthCalledWith(
      1,
      'spreadsheet-token',
      'sheet-august!A1:B200',
      expect.anything(),
    );
  });

  it('does not fall back to environment credentials when request values are absent', async () => {
    const { service, wikiClient } = createService(
      [['8.24-8.28', '张三']],
      [['旧内容', '保留', '不变', '旧内容', '旧内容']],
    );
    const settings: WeeklyReportPublishSettingsInput = {
      appId: '',
      appSecret: '',
      wikiUrl: 'https://tthdtech.feishu.cn/sheets/spreadsheet-token?sheet=sheet-august',
      name: '张三',
    };

    await service.publishIfEnabled(result, { enabled: true, settings });

    expect(wikiClient.resolveSpreadsheet).toHaveBeenCalledWith(
      settings.wikiUrl,
      expect.objectContaining({ appId: '', appSecret: '' }),
    );
  });

  it('does not auto-publish a this-week result', async () => {
    const { service, sheetsClient } = createService([], []);

    await expect(service.publishIfEnabled({ ...result, period: 'this-week' })).resolves.toBeNull();
    expect(sheetsClient.listSheets).not.toHaveBeenCalled();
    expect(sheetsClient.updateValues).not.toHaveBeenCalled();
  });

  it('updates only the matched C:G range when values changed', async () => {
    const { service, sheetsClient } = createService(
      [['8.24-8.28', '张三']],
      [['旧内容', '保留', '不变', '旧内容', '旧内容']],
    );

    const publication = await service.publishIfEnabled(result, { person: '张三' });

    expect(publication).toMatchObject({ status: 'succeeded', row: 1, range: 'sheet-august!C1:G1' });
    expect(sheetsClient.readValues).toHaveBeenNthCalledWith(
      1,
      'spreadsheet-token',
      'sheet-august!A1:B200',
      expect.objectContaining({ appId: 'app-id', requestTimeoutMs: 15_000 }),
    );
    expect(sheetsClient.readValues).toHaveBeenNthCalledWith(
      2,
      'spreadsheet-token',
      'sheet-august!C1:G1',
      expect.objectContaining({ appId: 'app-id', requestTimeoutMs: 15_000 }),
    );
    expect(sheetsClient.updateValues).toHaveBeenCalledTimes(1);
    expect(sheetsClient.updateValues).toHaveBeenCalledWith(
      'spreadsheet-token',
      'sheet-august!C1:G1',
      [['1. 完成接口', '1. 补充测试', '1. 整理文档', '1. 修复导出', '1. 发布验证']],
      expect.objectContaining({ appId: 'app-id', requestTimeoutMs: 15_000 }),
    );
  });
});
