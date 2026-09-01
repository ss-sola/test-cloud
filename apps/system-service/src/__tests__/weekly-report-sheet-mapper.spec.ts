import { describe, expect, it } from 'vitest';
import { WeeklyReportSheetMapper } from '../modules/weekly-commit-report/weekly-report-sheet-mapper';
import type { WeeklyReportResult } from '../modules/weekly-commit-report/weekly-report.types';

const mapper = new WeeklyReportSheetMapper();
const result: WeeklyReportResult = {
  period: 'last-week',
  weekStart: '2026-08-24',
  weekEnd: '2026-08-30',
  markdown: '# report\n',
  projects: [],
  projectErrors: [],
  commitCount: 2,
  degraded: false,
  dailySections: [
    { date: '2026-08-24', logs: [], bullets: ['完成接口', '补充测试'] },
    { date: '2026-08-25', logs: [], bullets: ['修复导出'] },
    { date: '2026-08-26', logs: [], bullets: ['无新增事项。'] },
    { date: '2026-08-27', logs: [], bullets: ['整理文档'] },
    { date: '2026-08-28', logs: [], bullets: ['发布验证'] },
  ],
};

describe('weekly report sheet mapper', () => {
  it('maps five daily sections to exactly the C:G row', () => {
    expect(mapper.toWeekdayWrite(result, 12)).toEqual({
      range: 'C12:G12',
      values: [['完成接口\n补充测试', '修复导出', '无新增事项。', '整理文档', '发布验证']],
      sections: result.dailySections,
    });
  });

  it('uses plain text and protects formula-like content', () => {
    expect(mapper.toCellText(['=HYPERLINK("https://example.com")'])).toBe(
      '\'=HYPERLINK("https://example.com")',
    );
    expect(mapper.toCellText([])).toBe('无新增事项。');
  });

  it('rejects a result without five workdays', () => {
    expect(() =>
      mapper.toWeekdayWrite({ ...result, dailySections: result.dailySections?.slice(0, 4) }, 1),
    ).toThrow(/完整的周一至周五/);
  });
});
