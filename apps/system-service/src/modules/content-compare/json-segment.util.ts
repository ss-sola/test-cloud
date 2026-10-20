import { CONTENT_COMPARE_LIMITS } from '../../constants/content-compare.constants';
import { COMPARE_MESSAGES, JSON_INDENT } from '../../constants/content-compare-internal.constants';
import { ContentCompareException } from './content-compare.exception';
import type { CompareSide, DiffSegment, JsonValue } from './content-compare.types';
import { DiffSegmentWriter } from './diff-segment-writer.util';
import { JsonCompareUtil, type InternalDiffNode } from './json-compare.util';
import type { OutputBudgetUtil } from './output-budget.util';

export interface JsonSegmentOptions {
  root: InternalDiffNode;
  side: CompareSide;
  budget: OutputBudgetUtil;
}

interface SegmentContext {
  writer: DiffSegmentWriter;
  side: CompareSide;
  /** 紧凑布局：无换行与缩进，冒号后无空格。 */
  compact: boolean;
}

type SegmentStatus = DiffSegment['status'];

/** 按差异树生成单侧 JSON 高亮分段；回填文本必须由分段拼接，保证与高亮一致。 */
export class JsonSegmentUtil {
  /**
   * 生成指定一侧的分段，写入前逐段累计输出预算。
   * 缩进格式超过单侧字符上限时自动改用紧凑格式；紧凑格式仍超限则抛出 413，避免回填无法再次提交的文本。
   */
  static serialize(options: JsonSegmentOptions): DiffSegment[] {
    const { root, side, budget } = options;
    const value = side === 'left' ? root.left : root.right;
    const maxLength = CONTENT_COMPARE_LIMITS.maxTextLength;
    // 在写入任何分段和预算前，用有界遍历确定布局
    const compact = JsonSegmentUtil.measure(value, 0, false) > maxLength;
    if (compact && JsonSegmentUtil.measure(value, 0, true) > maxLength) {
      throw new ContentCompareException(COMPARE_MESSAGES.normalizedTooLarge, undefined, 413);
    }
    const context: SegmentContext = { writer: new DiffSegmentWriter(budget), side, compact };
    JsonSegmentUtil.renderNode(context, root, 0);
    return context.writer.finish();
  }

  private static lineBreak(depth: number, compact: boolean): string {
    return compact ? '' : `\n${JSON_INDENT.repeat(depth)}`;
  }

  /** 计算规范化值按指定布局渲染后的字符数，与 renderRaw 的输出逐字符一致，但不创建输出文本。 */
  private static measure(value: JsonValue | undefined, depth: number, compact: boolean): number {
    const breakLength = (level: number) => (compact ? 0 : 1 + JSON_INDENT.length * level);
    if (Array.isArray(value)) {
      if (!value.length) return 2;
      let length =
        2 + (value.length - 1) + value.length * breakLength(depth + 1) + breakLength(depth);
      for (const item of value) length += JsonSegmentUtil.measure(item, depth + 1, compact);
      return length;
    }
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value);
      if (!keys.length) return 2;
      const colon = compact ? 1 : 2;
      let length =
        2 + (keys.length - 1) + keys.length * (breakLength(depth + 1) + colon) + breakLength(depth);
      for (const key of keys) {
        length +=
          JSON.stringify(key).length + JsonSegmentUtil.measure(value[key], depth + 1, compact);
      }
      return length;
    }
    return JSON.stringify(value).length;
  }

  private static segmentStatus(node: InternalDiffNode, side: CompareSide): SegmentStatus {
    if (node.status === 'added') return side === 'right' ? 'added' : null;
    if (node.status === 'removed') return side === 'left' ? 'removed' : null;
    if (node.status === 'modified' && !node.children.length) return 'modified';
    return null;
  }

  private static renderRaw(
    writer: DiffSegmentWriter,
    value: JsonValue | undefined,
    options: { depth: number; status: SegmentStatus; compact: boolean },
  ): void {
    const { depth, status, compact } = options;
    const child = { depth: depth + 1, status, compact };
    if (Array.isArray(value)) {
      writer.add('[', status);
      value.forEach((item, index) => {
        writer.add(
          `${index === 0 ? '' : ','}${JsonSegmentUtil.lineBreak(depth + 1, compact)}`,
          status,
        );
        JsonSegmentUtil.renderRaw(writer, item, child);
      });
      if (value.length) writer.add(JsonSegmentUtil.lineBreak(depth, compact), status);
      writer.add(']', status);
      return;
    }

    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value).sort();
      writer.add('{', status);
      keys.forEach((key, index) => {
        writer.add(
          `${index === 0 ? '' : ','}${JsonSegmentUtil.lineBreak(depth + 1, compact)}`,
          status,
        );
        writer.add(JSON.stringify(key), status);
        writer.add(compact ? ':' : ': ', status);
        JsonSegmentUtil.renderRaw(writer, value[key], child);
      });
      if (keys.length) writer.add(JsonSegmentUtil.lineBreak(depth, compact), status);
      writer.add('}', status);
      return;
    }

    writer.add(JSON.stringify(value), status);
  }

  private static renderNode(context: SegmentContext, node: InternalDiffNode, depth: number): void {
    const { writer, side, compact } = context;
    const hasValue = side === 'left' ? node.hasLeft : node.hasRight;
    if (!hasValue) return;
    const value = side === 'left' ? node.left : node.right;

    if (!node.children.length || node.status === 'added' || node.status === 'removed') {
      JsonSegmentUtil.renderRaw(writer, value, {
        depth,
        status: JsonSegmentUtil.segmentStatus(node, side),
        compact,
      });
      return;
    }

    const isArray = node.type === 'array';
    const sideChildren = node.children.filter((child) =>
      side === 'left' ? child.hasLeft : child.hasRight,
    );
    const children = node.identityField
      ? JsonSegmentUtil.orderByIdentity(sideChildren, value as JsonValue[], node.identityField)
      : sideChildren;
    writer.add(isArray ? '[' : '{', null);
    children.forEach((child, index) => {
      writer.add(`${index === 0 ? '' : ','}${JsonSegmentUtil.lineBreak(depth + 1, compact)}`, null);
      if (!isArray) {
        writer.add(JSON.stringify(String(child.key)), JsonSegmentUtil.segmentStatus(child, side));
        writer.add(compact ? ':' : ': ', null);
      }
      JsonSegmentUtil.renderNode(context, child, depth + 1);
    });
    if (children.length) writer.add(JsonSegmentUtil.lineBreak(depth, compact), null);
    writer.add(isArray ? ']' : '}', null);
  }

  /** 身份数组的子节点按本侧数组实际顺序输出，而非按身份键排序。 */
  private static orderByIdentity(
    children: InternalDiffNode[],
    sideArray: JsonValue[],
    field: string,
  ): InternalDiffNode[] {
    const sideOrder = new Map(
      sideArray.map((item, index) => [
        JsonCompareUtil.typedIdentityKey((item as { [key: string]: JsonValue })[field]),
        index,
      ]),
    );
    return children
      .map((child) => ({
        child,
        order: sideOrder.get(JsonCompareUtil.typedIdentityKey(child.key)) ?? 0,
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ child }) => child);
  }
}
