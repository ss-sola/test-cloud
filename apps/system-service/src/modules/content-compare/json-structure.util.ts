import { CONTENT_COMPARE_LIMITS } from '../../constants/content-compare.constants';
import { COMPARE_ERROR_CODES } from '../../constants/content-compare-internal.constants';
import type { CompareParseError, JsonValue } from './content-compare.types';
import { JsonPathUtil } from './json-path.util';

interface PendingNode {
  value: JsonValue;
  depth: number;
  pathLength: number;
}

/** 解析后的结构限额检查：迭代遍历，在进入递归比较前限制层级、节点数和路径长度。 */
export class JsonStructureUtil {
  /**
   * 检查层级（容器嵌套）、节点数和对象键/数组下标路径长度，返回首个超限错误。
   * 身份数组的路径更长，由比较阶段按实际路径再次校验。
   */
  static inspect(root: JsonValue, limits = CONTENT_COMPARE_LIMITS): CompareParseError | null {
    const stack: PendingNode[] = [{ value: root, depth: 1, pathLength: 1 }];
    let nodes = 1;
    while (stack.length) {
      const { value, depth, pathLength } = stack.pop() as PendingNode;
      if (value === null || typeof value !== 'object') continue;
      if (depth > limits.maxDepth) {
        return {
          code: COMPARE_ERROR_CODES.depthLimit,
          message: `结构层级超过 ${limits.maxDepth} 层限制。`,
        };
      }

      if (Array.isArray(value)) {
        nodes += value.length;
        if (nodes > limits.maxNodes) return JsonStructureUtil.nodeLimitError(limits.maxNodes);
        const childPathLength = pathLength + 2 + String(Math.max(value.length - 1, 0)).length;
        if (value.length && childPathLength > limits.maxPathLength) {
          return JsonStructureUtil.pathLimitError(limits.maxPathLength);
        }
        for (const item of value)
          stack.push({ value: item, depth: depth + 1, pathLength: childPathLength });
        continue;
      }

      const keys = Object.keys(value);
      nodes += keys.length;
      if (nodes > limits.maxNodes) return JsonStructureUtil.nodeLimitError(limits.maxNodes);
      for (const key of keys) {
        // 片段长度至少为键长加 1，先用下界提前拒绝，再按实际片段（含转义）计算
        if (pathLength + 1 + key.length > limits.maxPathLength) {
          return JsonStructureUtil.pathLimitError(limits.maxPathLength);
        }
        const childPathLength = pathLength + JsonPathUtil.keySegment(key).length;
        if (childPathLength > limits.maxPathLength) {
          return JsonStructureUtil.pathLimitError(limits.maxPathLength);
        }
        stack.push({ value: value[key], depth: depth + 1, pathLength: childPathLength });
      }
    }
    return null;
  }

  private static nodeLimitError(maxNodes: number): CompareParseError {
    return { code: COMPARE_ERROR_CODES.nodeLimit, message: `节点数量超过 ${maxNodes} 个限制。` };
  }

  private static pathLimitError(maxPathLength: number): CompareParseError {
    return {
      code: COMPARE_ERROR_CODES.pathLimit,
      message: `路径长度超过 ${maxPathLength} 字符限制。`,
    };
  }
}
