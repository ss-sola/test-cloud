import { Injectable } from '@nestjs/common';
import { CONTENT_COMPARE_LIMITS } from '../../constants/content-compare.constants';
import {
  COMPARE_ERROR_CODES,
  COMPARE_MESSAGES,
} from '../../constants/content-compare-internal.constants';
import { ContentCompareException } from './content-compare.exception';
import type {
  CompareContentInput,
  CompareFormat,
  CompareParseError,
  ContentCompareResult,
  DiffSegment,
  DiffStatus,
  JsonValue,
} from './content-compare.types';
import { EnvParserUtil } from './env-parser.util';
import { JsonCompareUtil } from './json-compare.util';
import { JsonSegmentUtil } from './json-segment.util';
import { JsonStructureUtil } from './json-structure.util';
import { OutputBudgetUtil } from './output-budget.util';

/** 单侧解析结果：errors 非空表示该侧无效。 */
interface ParsedSide {
  value: JsonValue;
  errors: CompareParseError[];
  /** ENV 行号到键映射；JSON 对象兼容输入与 JSON 格式为 null。 */
  lineKeys: Map<number, string> | null;
}

/** 在单次请求内完成 JSON/ENV 解析、规范化、差异树和高亮分段，不缓存、不持久化、不访问外部服务。 */
@Injectable()
export class ContentCompareService {
  /**
   * 比较两侧 JSON 或 ENV 文本。
   * 两侧都解析后统一抛出 ContentCompareException(400，含按侧错误)；结果超过输出预算时抛出 413。
   */
  compare(input: CompareContentInput): ContentCompareResult {
    const left = this.parseSide(input.format, input.left);
    const right = this.parseSide(input.format, input.right);
    if (left.errors.length || right.errors.length) {
      throw new ContentCompareException(COMPARE_MESSAGES.invalidInput, {
        left: left.errors,
        right: right.errors,
      });
    }

    const budget = new OutputBudgetUtil();
    const outcome = JsonCompareUtil.compare({ left: left.value, right: right.value, budget });
    const { root, tree, stats } = outcome;

    if (input.format === 'json') {
      const segments = {
        left: JsonSegmentUtil.serialize({ root, side: 'left', budget }),
        right: JsonSegmentUtil.serialize({ root, side: 'right', budget }),
      };
      return {
        leftText: segments.left.map((segment) => segment.text).join(''), // 回填文本取自分段，保证数字键等顺序一致
        rightText: segments.right.map((segment) => segment.text).join(''),
        stats,
        tree,
        segments,
      };
    }

    const statuses = new Map<string, DiffStatus>(
      root.children.map((child) => [String(child.key), child.status]),
    );
    const buildSegments = (
      side: 'left' | 'right',
      text: string,
      lineKeys: ParsedSide['lineKeys'],
    ) => EnvParserUtil.buildSegments({ text, side, lineKeys, statuses, budget });
    const segments: { left: DiffSegment[]; right: DiffSegment[] } = {
      left: buildSegments('left', input.left, left.lineKeys),
      right: buildSegments('right', input.right, right.lineKeys),
    };
    return { leftText: input.left, rightText: input.right, stats, tree, segments };
  }

  /** 校验类型、长度、空内容，解析文本并检查结构限额；失败只返回不含原文的错误。 */
  private parseSide(format: CompareFormat, text: string): ParsedSide {
    const fail = (code: string, message: string): ParsedSide => ({
      value: null,
      errors: [{ code, message }],
      lineKeys: null,
    });
    if (typeof text !== 'string')
      return fail(COMPARE_ERROR_CODES.invalidType, COMPARE_MESSAGES.invalidType);
    if (text.length > CONTENT_COMPARE_LIMITS.maxTextLength) {
      return fail(
        COMPARE_ERROR_CODES.textTooLong,
        `内容长度超过 ${CONTENT_COMPARE_LIMITS.maxTextLength} 字符限制。`,
      );
    }
    const trimmed = text.trim();
    if (!trimmed) return fail(COMPARE_ERROR_CODES.empty, COMPARE_MESSAGES.empty);

    let value: JsonValue;
    let lineKeys: ParsedSide['lineKeys'] = null;
    if (format === 'env' && !trimmed.startsWith('{')) {
      const parsed = EnvParserUtil.parse(text);
      if (!parsed.ok) {
        return {
          value: null,
          errors: parsed.errors.slice(0, CONTENT_COMPARE_LIMITS.maxErrors),
          lineKeys: null,
        };
      }
      value = parsed.value as JsonValue;
      lineKeys = parsed.lineKeys;
    } else {
      try {
        value = JSON.parse(text) as JsonValue;
      } catch {
        // 不传播原生 SyntaxError，其消息可能包含原文片段
        return fail(
          COMPARE_ERROR_CODES.invalidJson,
          format === 'env' ? COMPARE_MESSAGES.invalidEnvJson : COMPARE_MESSAGES.invalidJson,
        );
      }
    }

    const structureError = JsonStructureUtil.inspect(value);
    return structureError
      ? { value: null, errors: [structureError], lineKeys: null }
      : { value, errors: [], lineKeys };
  }
}
