import type { FeishuMergeRange } from '../../client/feishu/feishu-sheet-gateway.service';
import {
  A1_RANGE_PATTERN,
  COLUMN_NAME_PATTERN,
  FEISHU_FORMULA_PREFIX_PATTERN,
  WORKFLOW_CAPABILITY_LIMITS,
} from '../../constants/workflow-capability.constants';
import { WorkflowCapabilityException } from './workflow-capability.exception';

export interface A1Range {
  startColumn: number;
  endColumn: number;
  startRow: number;
  endRow: number;
}

export type CellInput = string | number | boolean | null;

export interface RowMatcher {
  column: string;
  value: string;
  mode: 'equals' | 'contains';
}

/** 将 A/AA 列名转换为 1 基列序号；非法列名返回 0。 */
export function columnToIndex(column: string): number {
  if (!COLUMN_NAME_PATTERN.test(column)) return 0;
  let index = 0;
  for (const char of column) index = index * 26 + (char.charCodeAt(0) - 64);
  return index <= WORKFLOW_CAPABILITY_LIMITS.feishuMaxColumnIndex ? index : 0;
}

/** 解析并校验 A1 范围（不含 sheetId）；行列顺序、绝对行列上限和单元格预算由调用方指定。 */
export function parseA1Range(
  range: string,
  budget: { maxRows: number; maxColumns: number; maxCells: number },
): A1Range {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!match || !A1_RANGE_PATTERN.test(range)) {
    throw new WorkflowCapabilityException('range 必须是形如 A1:B10 的绝对范围。', 400);
  }
  const parsed: A1Range = {
    startColumn: columnToIndex(match[1]),
    startRow: Number(match[2]),
    endColumn: columnToIndex(match[3]),
    endRow: Number(match[4]),
  };
  if (
    !parsed.startColumn ||
    !parsed.endColumn ||
    parsed.endColumn < parsed.startColumn ||
    parsed.endRow < parsed.startRow ||
    parsed.endRow > WORKFLOW_CAPABILITY_LIMITS.feishuMaxRow
  ) {
    throw new WorkflowCapabilityException('range 的行列顺序或边界无效。', 400);
  }
  const rows = parsed.endRow - parsed.startRow + 1;
  const columns = parsed.endColumn - parsed.startColumn + 1;
  if (rows > budget.maxRows || columns > budget.maxColumns || rows * columns > budget.maxCells) {
    throw new WorkflowCapabilityException('range 超过允许的行、列或单元格预算。', 422);
  }
  return parsed;
}

/** 单元格统一转为可比较的文本；富文本段取其 text，其他对象视为空。 */
export function normalizeCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.normalize('NFC').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value))
    return value
      .map((item) => normalizeCellText(item))
      .join('')
      .trim();
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' ? text.normalize('NFC').trim() : '';
}

/**
 * 按合并区域补齐读取结果：飞书只在合并区域左上角返回值，区域内其余单元格均取该值，
 * 与表格中看到的一致。左上角落在请求范围之外时无法取值，明确拒绝而不是当作空单元格。
 */
export function fillMergedCells(
  values: unknown[][],
  range: A1Range,
  merges: FeishuMergeRange[],
): unknown[][] {
  const filled = values.map((row) => [...row]);
  for (const merge of merges) {
    // 飞书下标从 0 开始，范围行列从 1 开始
    const top = merge.startRowIndex + 1;
    const left = merge.startColumnIndex + 1;
    const bottom = top + merge.rowCount - 1;
    const right = left + merge.columnCount - 1;
    if (
      bottom < range.startRow ||
      top > range.endRow ||
      right < range.startColumn ||
      left > range.endColumn
    )
      continue;
    if (top < range.startRow || left < range.startColumn) {
      throw new WorkflowCapabilityException(
        '查找范围截断了合并单元格，请扩大范围以包含合并区域的首行和首列。',
        422,
      );
    }
    const value = values[top - range.startRow]?.[left - range.startColumn] ?? null;
    for (let row = top; row <= Math.min(bottom, range.endRow); row += 1) {
      const cells = (filled[row - range.startRow] ??= []);
      for (let column = left; column <= Math.min(right, range.endColumn); column += 1) {
        cells[column - range.startColumn] = value;
      }
    }
  }
  return filled;
}

/** 在请求范围的全部行内按全部条件匹配，要求恰好一行，返回绝对 1 基行号。 */
export function findUniqueRow(values: unknown[][], range: A1Range, matchers: RowMatcher[]): number {
  const width = range.endColumn - range.startColumn + 1;
  const resolved = matchers.map((matcher) => {
    const offset = columnToIndex(matcher.column) - range.startColumn;
    if (offset < 0 || offset >= width) {
      throw new WorkflowCapabilityException('匹配列必须位于 range 之内。', 400);
    }
    const expected = normalizeCellText(matcher.value);
    if (matcher.mode === 'contains' && !expected) {
      throw new WorkflowCapabilityException('contains 匹配的 value 不能为空。', 400);
    }
    return { offset, expected, mode: matcher.mode };
  });

  const rows: number[] = [];
  // 飞书会省略尾部空行/空列：必须按请求范围的全部行遍历，缺失的行和列视为空单元格
  const rowCount = range.endRow - range.startRow + 1;
  for (let index = 0; index < rowCount; index += 1) {
    const row = values[index] ?? [];
    const matched = resolved.every(({ offset, expected, mode }) => {
      const cell = normalizeCellText(row[offset]);
      return mode === 'equals' ? cell === expected : cell.includes(expected);
    });
    if (matched) rows.push(range.startRow + index);
  }
  if (rows.length === 0) throw new WorkflowCapabilityException('指定范围内没有匹配的行。', 404);
  if (rows.length > 1) {
    throw new WorkflowCapabilityException('指定范围内匹配到多行，无法唯一确定目标。', 409);
  }
  return rows[0];
}

/** 校验矩阵为矩形且尺寸与范围一致。 */
export function assertMatrixMatchesRange(values: CellInput[][], range: A1Range): void {
  const rows = range.endRow - range.startRow + 1;
  const columns = range.endColumn - range.startColumn + 1;
  if (values.length !== rows || values.some((row) => row.length !== columns)) {
    throw new WorkflowCapabilityException('values 的行列数必须与 range 完全一致。', 400);
  }
}

/** 转为可写入的值：null 写成空文本；以公式/控制字符开头的文本加单引号前缀按字面量保存。 */
export function toWritableCell(value: CellInput): string | number | boolean {
  if (value === null) return '';
  if (typeof value === 'string' && FEISHU_FORMULA_PREFIX_PATTERN.test(value)) return `'${value}`;
  return value;
}

/** 判断已有内容是否已经等于待写入矩阵（飞书可能省略尾部空单元格，也可能还原单引号前缀）。 */
export function matrixAlreadyWritten(current: unknown[][], desired: CellInput[][]): boolean {
  return desired.every((row, rowIndex) =>
    row.every((value, columnIndex) => {
      const cell = current[rowIndex]?.[columnIndex];
      const actual = cell === null || cell === undefined ? '' : normalizeCurrent(cell);
      const text = value === null ? '' : String(value);
      return actual === text || actual === String(toWritableCell(value));
    }),
  );
}

function normalizeCurrent(value: unknown): string {
  return (typeof value === 'string' ? value : normalizeCellText(value)).replace(/\r\n/g, '\n');
}
