import { ParamsErrorException } from '@nest-cloud/common';

export interface WeeklyReportTargetRow {
  row: number;
  dateRange: string;
  person: string;
}

export function findWeeklyReportTargetRow(
  values: unknown[][],
  lookupRange: string,
  weekStart: string,
  weekEnd: string,
  person: string,
): WeeklyReportTargetRow {
  const startRow = getLookupStartRow(lookupRange);
  const expectedDateRange = toMonthDayRange(weekStart, weekEnd);
  const expectedPerson = normalizeCellText(person);
  if (!expectedPerson) {
    throw new ParamsErrorException('飞书周报发布缺少姓名。');
  }

  const matches: WeeklyReportTargetRow[] = [];
  let currentDateRange = '';
  values.forEach((rowValues, index) => {
    const cellDateRange = normalizeCellText(rowValues[0]);
    if (cellDateRange) currentDateRange = cellDateRange;
    const rowPerson = normalizeCellText(rowValues[1]);
    if (!currentDateRange || !rowPerson) return;
    if (toMonthDayRange(currentDateRange) !== expectedDateRange || rowPerson !== expectedPerson)
      return;

    matches.push({
      row: startRow + index,
      dateRange: currentDateRange,
      person: rowPerson,
    });
  });

  if (matches.length === 0) {
    throw new ParamsErrorException(`飞书表格中未找到 ${weekStart}~${weekEnd} / ${person} 对应行。`);
  }
  if (matches.length > 1) {
    throw new ParamsErrorException(
      `飞书表格中存在多条 ${weekStart}~${weekEnd} / ${person} 对应行。`,
    );
  }

  return matches[0];
}

export function normalizeCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function toMonthDayRange(startOrRange: string, end?: string): string {
  if (end) {
    return `${toMonthDay(startOrRange)}-${toMonthDay(end)}`;
  }

  const raw = normalizeCellText(startOrRange);
  if (!/[~至—–－-]/.test(raw)) return '';
  const numbers = raw.match(/\d+/g)?.map(Number) ?? [];
  if (numbers.length >= 6 && numbers[0] >= 1900 && numbers[3] >= 1900) {
    return `${formatMonthDay(numbers[1], numbers[2])}-${formatMonthDay(numbers[4], numbers[5])}`;
  }
  if (numbers.length === 5 && numbers[0] >= 1900) {
    return `${formatMonthDay(numbers[1], numbers[2])}-${formatMonthDay(numbers[3], numbers[4])}`;
  }
  if (numbers.length >= 4) {
    return `${formatMonthDay(numbers[0], numbers[1])}-${formatMonthDay(numbers[2], numbers[3])}`;
  }
  return '';
}

function toMonthDay(date: string): string {
  const match = /^\d{4}-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
  if (!match) return '';
  return formatMonthDay(Number(match[1]), Number(match[2]));
}

function formatMonthDay(month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getLookupStartRow(lookupRange: string): number {
  const match = /^A(\d+):B(\d+)$/i.exec(lookupRange.trim());
  if (!match || Number(match[1]) < 1 || Number(match[2]) < Number(match[1])) {
    throw new ParamsErrorException('飞书周报查找范围必须是合法的 A1:Bn 范围。');
  }
  return Number(match[1]);
}
