import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength, ValidateBy, ValidateIf } from 'class-validator';
import { ISO_DATE_TIME_PATTERN } from '../../../constants/workflow-capability.constants';
import { WORKFLOW_EXECUTION_LIMITS } from '../../../constants/workflow-execution.constants';

/** 原样读取请求字段，避免全局隐式转换把数字、数组等值转成字符串后绕过 IsString。 */
export const rawValue = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key];

/** 凭据与服务地址：可见 ASCII，允许为空串，防止写入 HTTP 头时发生头注入。 */
export const VISIBLE_ASCII_OR_EMPTY_PATTERN = /^[\x21-\x7E]*$/;

interface RawStringOptions {
  max: number;
  min?: number;
  pattern?: RegExp;
  /** 为 true 时允许字段缺省（undefined）；null 与其他类型仍然拒绝。 */
  optional?: boolean;
  /** 自定义校验条件，返回 false 时跳过该字段；优先于 optional。 */
  condition?: (object: any, value: unknown) => boolean;
}

/** 受约束的原始字符串字段：类型、长度和可选字符集。 */
export function RawString(options: RawStringOptions) {
  const condition =
    options.condition ??
    (options.optional ? (_object: unknown, value: unknown) => value !== undefined : undefined);
  return applyDecorators(
    Transform(rawValue),
    ...(condition ? [ValidateIf(condition)] : []),
    IsString(),
    MinLength(options.min ?? 0),
    MaxLength(options.max),
    ...(options.pattern ? [Matches(options.pattern)] : []),
  );
}

/** 字符串的 UTF-8 字节数不超过上限；字符数上限只能做粗筛，多字节字符会放大。 */
export const MaxUtf8Bytes = (max: number) =>
  ValidateBy({
    name: 'maxUtf8Bytes',
    constraints: [max],
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max,
    },
  });

/** 带时区偏移的完整 ISO 日期时间，且能解析为有效时间点。 */
export const IsZonedIsoDateTime = () =>
  ValidateBy({
    name: 'isZonedIsoDateTime',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        ISO_DATE_TIME_PATTERN.test(value) &&
        Number.isFinite(Date.parse(value)),
    },
  });

/** 运行时可识别的 IANA 时区名。 */
export const IsIanaTimeZone = () =>
  ValidateBy({
    name: 'isIanaTimeZone',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string') return false;
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      },
    },
  });

/**
 * 逐项累计上游输出的 UTF-8 近似字节数与嵌套深度（输出对象本身为 1 层），
 * 用迭代遍历避免恶意深层 JSON 造成调用栈溢出；超出任一预算立即返回 false。
 * 输出端口与结构的真实校验由执行核心负责，这里只做 HTTP 边界的资源预算。
 */
function withinPreviousBudget(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > WORKFLOW_EXECUTION_LIMITS.maxPreviousOutputs) {
    return false;
  }
  let bytes = 0;
  const stack: [unknown, number][] = [];
  for (const item of value) {
    const outputs = (item as { outputs?: unknown } | null)?.outputs;
    if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) return false;
    stack.push([outputs, 1]);
  }
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (typeof node === 'string') {
      bytes += Buffer.byteLength(node, 'utf8');
    } else if (typeof node === 'number') {
      bytes += 8;
    } else if (typeof node === 'boolean' || node === null) {
      bytes += 5;
    } else if (typeof node === 'object') {
      if (depth > WORKFLOW_EXECUTION_LIMITS.maxPreviousDepth) return false;
      bytes += 2;
      if (Array.isArray(node)) {
        for (const child of node) stack.push([child, depth + 1]);
      } else {
        for (const key of Object.keys(node)) {
          bytes += Buffer.byteLength(key, 'utf8') + 4;
          stack.push([(node as Record<string, unknown>)[key], depth + 1]);
        }
      }
    } else {
      return false;
    }
    if (bytes > WORKFLOW_EXECUTION_LIMITS.maxPreviousBytes) return false;
  }
  return true;
}

/** 上游输出数组整体不超过项数、累计字节数和嵌套深度预算。 */
export const IsWithinPreviousBudget = () =>
  ValidateBy({
    name: 'isWithinPreviousBudget',
    validator: { validate: withinPreviousBudget },
  });
