import { Injectable } from '@nestjs/common';
import { FEISHU_MAX_CELL_CHARACTERS, FEISHU_WEEKDAY_COLUMNS } from './weekly-report.constants';
import type { DailyReportSection, WeeklyReportResult } from './weekly-report.types';

export interface WeeklyReportSheetWrite {
  range: string;
  values: string[][];
  sections: DailyReportSection[];
}

@Injectable()
export class WeeklyReportSheetMapper {
  toWeekdayWrite(result: WeeklyReportResult, row: number): WeeklyReportSheetWrite {
    const sections = result.dailySections ?? [];
    if (sections.length !== FEISHU_WEEKDAY_COLUMNS.length) {
      throw new Error('周报缺少完整的周一至周五摘要，已取消飞书写入。');
    }

    const values = sections.map((section) => this.toCellText(section.bullets));
    return {
      range: `${FEISHU_WEEKDAY_COLUMNS[0]}${row}:${FEISHU_WEEKDAY_COLUMNS.at(-1)}${row}`,
      values: [values],
      sections,
    };
  }

  toCellText(bullets: string[]): string {
    const lines = bullets
      .map((bullet) => String(bullet).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const numberedLines = lines.map((line, index) => {
      const safeLine = /^[=+\-@]/.test(line) ? `'${line}` : line;
      return `${index + 1}. ${safeLine}`;
    });
    const text = numberedLines.length > 0 ? numberedLines.join('\n') : '无新增事项。';
    const limited = text.slice(0, FEISHU_MAX_CELL_CHARACTERS);
    return /^[=+\-@]/.test(limited) ? `'${limited}` : limited;
  }
}
