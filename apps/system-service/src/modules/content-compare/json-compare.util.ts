import { CONTENT_COMPARE_LIMITS } from '../../constants/content-compare.constants';
import {
  COMPARE_ERROR_CODES,
  COMPARE_MESSAGES,
  NODE_OVERHEAD_BYTES,
  ROOT_KEY,
} from '../../constants/content-compare-internal.constants';
import { ContentCompareException } from './content-compare.exception';
import type { ContentDiffNode, DiffStatus, JsonValue } from './content-compare.types';
import type { OutputBudgetUtil } from './output-budget.util';
import { JsonPathUtil } from './json-path.util';

type JsonObject = { [key: string]: JsonValue };
type NodeType = ContentDiffNode['type'];

/** 内部差异节点：保留各侧原始值用于生成分段，对外只暴露 ContentDiffNode。 */
export interface InternalDiffNode {
  key: string | number;
  path: string;
  left: JsonValue | undefined;
  right: JsonValue | undefined;
  hasLeft: boolean;
  hasRight: boolean;
  status: DiffStatus;
  type: NodeType;
  leftDisplay: string;
  rightDisplay: string;
  children: InternalDiffNode[];
  identityField: string | null;
}

export interface JsonCompareOptions {
  left: JsonValue;
  right: JsonValue;
  budget: OutputBudgetUtil;
}

export interface JsonCompareOutcome {
  /** 含各侧原始值的内部树，仅供分段生成。 */
  root: InternalDiffNode;
  /** 紧凑的公共差异树，不含完整子树原文。 */
  tree: ContentDiffNode;
  stats: { added: number; removed: number; modified: number };
  /** 规范化后的左右值。 */
  left: JsonValue;
  right: JsonValue;
}

interface NodeEntry {
  key: string | number;
  path: string;
  left: JsonValue | undefined;
  right: JsonValue | undefined;
  hasLeft: boolean;
  hasRight: boolean;
}

interface CompareContext {
  stats: JsonCompareOutcome['stats'];
  budget: OutputBudgetUtil;
}

const hasOwn = (target: object, key: string) => Object.prototype.hasOwnProperty.call(target, key);

/** JSON 规范化与差异树计算；纯计算、无状态，对象键排序，id 数组按身份匹配，其余数组按规范序排序。 */
export class JsonCompareUtil {
  /** 类型限定的身份键，避免数字 1 与字符串 "1" 混淆。 */
  static typedIdentityKey(value: JsonValue | undefined): string {
    return `${typeof value}:${JSON.stringify(value)}`;
  }

  /** 递归规范化：对象键排序（使用无原型对象，特殊键仍为自有属性），数组按身份或规范序排序。 */
  static normalize(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
      const normalized = value.map((item) => JsonCompareUtil.normalize(item));
      const identityField = JsonCompareUtil.uniqueIdentityFields(normalized)[0];
      if (identityField !== undefined) {
        return JsonCompareUtil.sortByKey(normalized, (item) =>
          JsonCompareUtil.typedIdentityKey((item as JsonObject)[identityField]),
        );
      }
      return JsonCompareUtil.sortByKey(normalized, (item) => JSON.stringify(item));
    }

    if (value !== null && typeof value === 'object') {
      const result = Object.create(null) as JsonObject;
      for (const key of Object.keys(value).sort()) {
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: JsonCompareUtil.normalize(value[key]),
          writable: true,
        });
      }
      return result;
    }

    return value;
  }

  /**
   * 规范化两侧后构建差异树并累计输出预算。
   * 路径超长（含身份数组的编码路径）抛出 400，输出预算耗尽抛出 413。
   */
  static compare(options: JsonCompareOptions): JsonCompareOutcome {
    const context: CompareContext = {
      stats: { added: 0, removed: 0, modified: 0 },
      budget: options.budget,
    };
    const left = JsonCompareUtil.normalize(options.left);
    const right = JsonCompareUtil.normalize(options.right);
    const root = JsonCompareUtil.compareNode(context, {
      key: ROOT_KEY,
      path: ROOT_KEY,
      left,
      right,
      hasLeft: true,
      hasRight: true,
    });
    return { root, tree: JsonCompareUtil.toPublicNode(root), stats: context.stats, left, right };
  }

  private static getType(value: JsonValue | undefined): NodeType {
    if (Array.isArray(value)) return 'array';
    if (value !== null && typeof value === 'object') return 'object';
    return 'value';
  }

  /** 各侧按自身类型显示：容器只显示计数，标量显示 JSON 值，缺失侧为空串。 */
  private static display(value: JsonValue | undefined, present: boolean): string {
    if (!present) return '';
    if (Array.isArray(value)) return `[ ${value.length} 项 ]`;
    if (value !== null && typeof value === 'object') return `{ ${Object.keys(value).length} 个键 }`;
    return JSON.stringify(value);
  }

  private static sortByKey(items: JsonValue[], keyOf: (item: JsonValue) => string): JsonValue[] {
    return items
      .map((item) => ({ item, sortKey: keyOf(item) }))
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
      .map(({ item }) => item);
  }

  private static isIdentityField(name: string): boolean {
    return name === 'id' || /^[A-Za-z_][A-Za-z0-9]*Id$/.test(name);
  }

  private static isValidIdentity(value: JsonValue | undefined): boolean {
    return (
      (typeof value === 'string' && value.length > 0) ||
      (typeof value === 'number' && Number.isFinite(value))
    );
  }

  /** 返回数组中每个元素都具备且取值唯一的身份字段，id 优先。 */
  private static uniqueIdentityFields(array: JsonValue[]): string[] {
    if (
      !array.length ||
      !array.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
    ) {
      return [];
    }
    const items = array as JsonObject[];
    return Object.keys(items[0])
      .filter((key) => JsonCompareUtil.isIdentityField(key))
      .filter((key) => {
        if (
          !items.every((item) => hasOwn(item, key) && JsonCompareUtil.isValidIdentity(item[key]))
        ) {
          return false;
        }
        const ids = items.map((item) => JsonCompareUtil.typedIdentityKey(item[key]));
        return new Set(ids).size === ids.length;
      })
      .sort((left, right) => {
        if (left === 'id') return -1;
        if (right === 'id') return 1;
        return left < right ? -1 : left > right ? 1 : 0;
      });
  }

  private static findCommonIdentityField(left: JsonValue[], right: JsonValue[]): string | null {
    const rightFields = JsonCompareUtil.uniqueIdentityFields(right);
    const common = JsonCompareUtil.uniqueIdentityFields(left).filter((field) =>
      rightFields.includes(field),
    );
    if (common.includes('id')) return 'id';
    return common.length === 1 ? common[0] : null;
  }

  private static pathTooLongError(): ContentCompareException {
    const error = {
      code: COMPARE_ERROR_CODES.pathLimit,
      message: `路径长度超过 ${CONTENT_COMPARE_LIMITS.maxPathLength} 字符限制。`,
    };
    return new ContentCompareException(COMPARE_MESSAGES.invalidInput, {
      left: [error],
      right: [error],
    });
  }

  /** 拼接子路径，超过最大路径长度时在创建前拒绝。 */
  private static appendPath(path: string, segment: string): string {
    if (path.length + segment.length > CONTENT_COMPARE_LIMITS.maxPathLength) {
      throw JsonCompareUtil.pathTooLongError();
    }
    return path + segment;
  }

  private static identityPath(path: string, field: string, value: JsonValue): string {
    const canonical = JSON.stringify(value);
    // 编码只会变长，先用规范文本长度提前拒绝，避免为超长路径创建编码字符串
    if (path.length + field.length + canonical.length > CONTENT_COMPARE_LIMITS.maxPathLength) {
      throw JsonCompareUtil.pathTooLongError();
    }
    return JsonCompareUtil.appendPath(path, `[${field}=${encodeURIComponent(canonical)}]`);
  }

  private static compareNode(context: CompareContext, entry: NodeEntry): InternalDiffNode {
    const { key, path, left, right, hasLeft, hasRight } = entry;
    const leftDisplay = JsonCompareUtil.display(left, hasLeft);
    const rightDisplay = JsonCompareUtil.display(right, hasRight);
    // 在创建子节点和分段前累计节点输出预算
    context.budget.addBytes(NODE_OVERHEAD_BYTES);
    context.budget.addText(String(key));
    context.budget.addText(path);
    context.budget.addText(leftDisplay);
    context.budget.addText(rightDisplay);
    const node: InternalDiffNode = {
      key,
      path,
      left,
      right,
      hasLeft,
      hasRight,
      status: 'unchanged',
      type: 'value',
      leftDisplay,
      rightDisplay,
      children: [],
      identityField: null,
    };

    if (!hasLeft || !hasRight) {
      node.status = hasRight ? 'added' : 'removed';
      node.type = JsonCompareUtil.getType(hasRight ? right : left);
      context.stats[node.status] += 1;
      return node;
    }

    const leftType = JsonCompareUtil.getType(left);
    const rightType = JsonCompareUtil.getType(right);
    if (leftType !== rightType) {
      node.status = 'modified';
      context.stats.modified += 1;
      return node;
    }

    node.type = leftType;
    if (leftType === 'object') {
      node.children = JsonCompareUtil.compareObjectChildren(context, node);
    } else if (leftType === 'array') {
      node.identityField = JsonCompareUtil.findCommonIdentityField(
        left as JsonValue[],
        right as JsonValue[],
      );
      node.children = JsonCompareUtil.compareArrayChildren(context, node);
    } else if (!Object.is(left, right)) {
      node.status = 'modified';
      context.stats.modified += 1;
      return node;
    }

    if (node.children.some((child) => child.status !== 'unchanged')) node.status = 'modified';
    return node;
  }

  private static compareObjectChildren(
    context: CompareContext,
    node: InternalDiffNode,
  ): InternalDiffNode[] {
    const left = node.left as JsonObject;
    const right = node.right as JsonObject;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.map((childKey) =>
      JsonCompareUtil.compareNode(context, {
        key: childKey,
        path: JsonCompareUtil.appendPath(node.path, JsonPathUtil.keySegment(childKey)),
        left: left[childKey],
        right: right[childKey],
        hasLeft: hasOwn(left, childKey),
        hasRight: hasOwn(right, childKey),
      }),
    );
  }

  private static compareArrayChildren(
    context: CompareContext,
    node: InternalDiffNode,
  ): InternalDiffNode[] {
    const left = node.left as JsonValue[];
    const right = node.right as JsonValue[];
    const field = node.identityField;

    if (field) {
      const leftMap = new Map(
        left.map((item) => [JsonCompareUtil.typedIdentityKey((item as JsonObject)[field]), item]),
      );
      const rightMap = new Map(
        right.map((item) => [JsonCompareUtil.typedIdentityKey((item as JsonObject)[field]), item]),
      );
      const identityKeys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
      return identityKeys.map((identityKey) => {
        const leftItem = leftMap.get(identityKey);
        const rightItem = rightMap.get(identityKey);
        const identityValue = ((leftItem ?? rightItem) as JsonObject)[field];
        return JsonCompareUtil.compareNode(context, {
          key: identityValue as string | number,
          path: JsonCompareUtil.identityPath(node.path, field, identityValue),
          left: leftItem,
          right: rightItem,
          hasLeft: leftItem !== undefined,
          hasRight: rightItem !== undefined,
        });
      });
    }

    const length = Math.max(left.length, right.length);
    const children: InternalDiffNode[] = [];
    for (let index = 0; index < length; index += 1) {
      children.push(
        JsonCompareUtil.compareNode(context, {
          key: index,
          path: JsonCompareUtil.appendPath(node.path, `[${index}]`),
          left: left[index],
          right: right[index],
          hasLeft: index < left.length,
          hasRight: index < right.length,
        }),
      );
    }
    return children;
  }

  /** 将内部节点转为公共节点，丢弃各侧原始值与身份字段。 */
  private static toPublicNode(node: InternalDiffNode): ContentDiffNode {
    return {
      key: node.key,
      path: node.path,
      hasLeft: node.hasLeft,
      hasRight: node.hasRight,
      type: node.type,
      status: node.status,
      leftDisplay: node.leftDisplay,
      rightDisplay: node.rightDisplay,
      children: node.children.map((child) => JsonCompareUtil.toPublicNode(child)),
    };
  }
}
