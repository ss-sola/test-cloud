import { CONTENT_COMPARE_LIMITS } from '../../constants/content-compare.constants';
import { COMPARE_ERROR_CODES, UTF8_BOM } from '../../constants/content-compare-internal.constants';
import type {
  CompareParseError,
  CompareSide,
  DiffSegment,
  DiffStatus,
} from './content-compare.types';
import { DiffSegmentWriter } from './diff-segment-writer.util';
import type { OutputBudgetUtil } from './output-budget.util';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TRAILING_PATTERN = /^[ \t]+(?:#.*)?$/;
const LINE_BREAK_PATTERN = /\r\n?|\n/;
const QUOTED_ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' };

export interface EnvParseResult {
  ok: boolean;
  /** 无原型的键值表（特殊键同样是自有属性）；解析失败时为 null。 */
  value: Record<string, string> | null;
  errors: CompareParseError[];
  /** 行号（从 1 起，BOM 之后）到键名的映射，仅包含有效键值行。 */
  lineKeys: Map<number, string>;
}

export interface EnvSegmentOptions {
  text: string;
  side: CompareSide;
  /** 解析 ENV 时得到的行号到键映射；为 null 表示该侧是 JSON 对象兼容输入，整体作为一个未标色段。 */
  lineKeys: Map<number, string> | null;
  /** 顶层键到差异状态的映射。 */
  statuses: Map<string, DiffStatus>;
  budget: OutputBudgetUtil;
}

/** 手工去除首尾空格/制表符，避免正则对超长空白行回溯。 */
function trimBlanks(value: string, trailingOnly = false): string {
  let start = 0;
  let end = value.length;
  if (!trailingOnly)
    while (start < end && (value[start] === ' ' || value[start] === '\t')) start += 1;
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end -= 1;
  return value.slice(start, end);
}

/** ENV 文本解析与按行分段；只做字符串解析，不执行命令、不展开变量、不转换类型。 */
export class EnvParserUtil {
  /**
   * 解析 ENV：支持 BOM、CRLF/CR/LF、export、注释、引号/转义、空值。
   * 错误文案不含键名或原文片段；达到错误上限后停止解析。
   */
  static parse(text: string, maxErrors: number = CONTENT_COMPARE_LIMITS.maxErrors): EnvParseResult {
    const source = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
    const value = Object.create(null) as Record<string, string>;
    const keyLines = new Map<string, number>();
    const lineKeys = new Map<number, string>();
    const errors: CompareParseError[] = [];
    const lines = source.split(LINE_BREAK_PATTERN);

    for (let index = 0; index < lines.length && errors.length < maxErrors; index += 1) {
      const rawLine = lines[index];
      const line = index + 1;
      const content = trimBlanks(rawLine);
      if (!content || content[0] === '#') continue;

      const equalsIndex = rawLine.indexOf('=');
      if (equalsIndex < 0) {
        errors.push(
          EnvParserUtil.createError(
            COMPARE_ERROR_CODES.missingEquals,
            line,
            '缺少“键=值”中的等号。',
          ),
        );
        continue;
      }

      let rawKey = rawLine.slice(0, equalsIndex).trim();
      // 手工识别 export 前缀，避免正则对超长空白回溯
      if (rawKey.startsWith('export') && (rawKey[6] === ' ' || rawKey[6] === '\t')) {
        rawKey = rawKey.slice(7).trim();
      }

      if (!rawKey) {
        errors.push(
          EnvParserUtil.createError(COMPARE_ERROR_CODES.emptyKey, line, '键名不能为空。'),
        );
        continue;
      }
      if (!KEY_PATTERN.test(rawKey)) {
        errors.push(EnvParserUtil.createError(COMPARE_ERROR_CODES.invalidKey, line, '键名无效。'));
        continue;
      }
      const previousLine = keyLines.get(rawKey);
      if (previousLine !== undefined) {
        errors.push({
          ...EnvParserUtil.createError(
            COMPARE_ERROR_CODES.duplicateKey,
            line,
            `键重复；首次出现在第 ${previousLine} 行。`,
          ),
          previousLine,
        });
        continue;
      }

      const parsedValue = EnvParserUtil.parseValue(rawLine.slice(equalsIndex + 1), line, errors);
      if (parsedValue === null) continue;

      keyLines.set(rawKey, line);
      lineKeys.set(line, rawKey);
      Object.defineProperty(value, rawKey, {
        configurable: true,
        enumerable: true,
        value: parsedValue,
        writable: true,
      });
    }

    if (errors.length) return { ok: false, value: null, errors, lineKeys };
    return { ok: true, value, errors: [], lineKeys };
  }

  /**
   * 按物理行生成 ENV 分段：保留 BOM 与 CRLF/CR/LF 原文，键值行按顶层状态标色。
   * lineKeys 为 null（JSON 对象兼容输入）时整体作为一个未标色段。
   */
  static buildSegments(options: EnvSegmentOptions): DiffSegment[] {
    const { text, side, lineKeys, statuses } = options;
    const writer = new DiffSegmentWriter(options.budget);
    if (!lineKeys) {
      writer.add(text, null);
      return writer.finish();
    }

    let index = 0;
    if (text.startsWith(UTF8_BOM)) {
      writer.add(UTF8_BOM, null);
      index = 1;
    }
    for (let line = 1; ; line += 1) {
      let end = index;
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
      const terminator = text.startsWith('\r\n', end) ? '\r\n' : end < text.length ? text[end] : '';
      const key = lineKeys.get(line);
      const status = key === undefined ? undefined : statuses.get(key);
      writer.add(text.slice(index, end), EnvParserUtil.lineStatus(status, side));
      writer.add(terminator, null);
      if (!terminator) break;
      index = end + terminator.length;
    }
    return writer.finish();
  }

  /** 左侧不标新增、右侧不标删除；unchanged 不输出状态。 */
  private static lineStatus(
    status: DiffStatus | undefined,
    side: CompareSide,
  ): DiffSegment['status'] {
    if (!status || status === 'unchanged') return null;
    if (side === 'left' && status === 'added') return null;
    if (side === 'right' && status === 'removed') return null;
    return status;
  }

  /** 组装不含原文的行级错误。 */
  private static createError(code: string, line: number, message: string): CompareParseError {
    return { code, line, column: 1, message };
  }

  private static decodeQuotedValue(value: string, quote: string): string {
    let decoded = '';
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character !== '\\' || index === value.length - 1) {
        decoded += character;
        continue;
      }

      const next = value[index + 1];
      index += 1;
      if (quote === '"') {
        decoded += QUOTED_ESCAPES[next] ?? `\\${next}`;
      } else if (next === '\\' || next === "'") {
        decoded += next;
      } else {
        decoded += `\\${next}`;
      }
    }
    return decoded;
  }

  private static stripInlineComment(value: string): string {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === '#' && (value[index - 1] === ' ' || value[index - 1] === '\t')) {
        return trimBlanks(value.slice(0, index), true);
      }
    }
    return value;
  }

  /** 解析等号后的值；格式错误时记录错误并返回 null。 */
  private static parseValue(
    rawValue: string,
    line: number,
    errors: CompareParseError[],
  ): string | null {
    const value = trimBlanks(rawValue);
    if (!value) return '';

    const quote = value[0];
    if (quote !== '"' && quote !== "'") return EnvParserUtil.stripInlineComment(value);

    let closingIndex = -1;
    let escaped = false;
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === quote) {
        closingIndex = index;
        break;
      }
    }

    if (closingIndex < 0) {
      errors.push(
        EnvParserUtil.createError(COMPARE_ERROR_CODES.unterminatedQuote, line, '引号未闭合。'),
      );
      return null;
    }

    const trailing = value.slice(closingIndex + 1);
    if (trailing && !TRAILING_PATTERN.test(trailing)) {
      errors.push(
        EnvParserUtil.createError(
          COMPARE_ERROR_CODES.trailingContent,
          line,
          '闭合引号后存在无效内容。',
        ),
      );
      return null;
    }

    return EnvParserUtil.decodeQuotedValue(value.slice(1, closingIndex), quote);
  }
}
