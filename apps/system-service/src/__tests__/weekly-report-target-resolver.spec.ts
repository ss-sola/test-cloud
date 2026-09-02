import { describe, expect, it } from 'vitest';
import {
  findWeeklyReportTargetRow,
  toMonthDayRange,
} from '../modules/weekly-commit-report/weekly-report-target-resolver';

const lookupRange = 'A5:B20';

describe('weekly report target resolver', () => {
  it('normalizes a dotted date range and returns the physical row', () => {
    expect(toMonthDayRange('8.24-8.28')).toBe('08-24-08-28');
    expect(
      findWeeklyReportTargetRow(
        [
          ['8.24-8.28', '其他人'],
          ['8.24 - 8.28', '张三'],
        ],
        lookupRange,
        '2026-08-24',
        '2026-08-28',
        '张三',
      ),
    ).toMatchObject({ row: 6, person: '张三' });
  });

  it('inherits the last non-empty date range for merged date cells', () => {
    expect(
      findWeeklyReportTargetRow(
        [
          ['8.17-8.21', '李四'],
          [null, '王五'],
          ['8.24-8.28', '李四'],
          [null, '张三'],
        ],
        'A1:B20',
        '2026-08-24',
        '2026-08-28',
        '张三',
      ),
    ).toMatchObject({ row: 4, dateRange: '8.24-8.28', person: '张三' });
  });

  it('rejects missing or duplicate date/name matches', () => {
    expect(() =>
      findWeeklyReportTargetRow(
        [['8.24-8.28', '李四']],
        lookupRange,
        '2026-08-24',
        '2026-08-28',
        '张三',
      ),
    ).toThrow(/未找到/);

    expect(() =>
      findWeeklyReportTargetRow(
        [
          ['8.24-8.28', '张三'],
          ['8.24-8.28', '张三'],
        ],
        lookupRange,
        '2026-08-24',
        '2026-08-28',
        '张三',
      ),
    ).toThrow(/多条/);
  });

  it('requires a two-column A1 range', () => {
    expect(() =>
      findWeeklyReportTargetRow([], 'A1:C20', '2026-08-24', '2026-08-28', '张三'),
    ).toThrow(/A1:Bn/);
  });
});
