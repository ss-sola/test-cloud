import { CONTENT_COMPARE_LIMITS } from '../../constants/content-compare.constants';
import { COMPARE_MESSAGES } from '../../constants/content-compare-internal.constants';
import { ContentCompareException } from './content-compare.exception';

/**
 * 保守估算文本作为 JSON 字符串输出时的 UTF-8 字节数。
 * 控制字符按 \u00XX 计 6 字节，孤立代理项按 \udXXX 计 6 字节，成对代理项计 4 字节。
 */
export function estimateJsonBytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20) bytes += 6;
    else if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

/** 单次比较的输出预算：在生成路径、显示值和分段时累加，超限立即抛出 413，不依赖最终序列化检查。 */
export class OutputBudgetUtil {
  private usedBytes = 0;

  constructor(private readonly limitBytes: number = CONTENT_COMPARE_LIMITS.maxResponseBytes) {}

  get used(): number {
    return this.usedBytes;
  }

  /** 累加固定字节数；超过上限时抛出 ContentCompareException(413)。 */
  addBytes(bytes: number): void {
    this.usedBytes += bytes;
    if (this.usedBytes > this.limitBytes) {
      throw new ContentCompareException(COMPARE_MESSAGES.resultTooLarge, undefined, 413);
    }
  }

  /** 累加文本输出字节数，copies 表示同一文本在响应中出现的份数。 */
  addText(text: string, copies = 1): void {
    // 字符数是字节数的下界，先于逐字符扫描拒绝明显超限的文本
    if (text.length * copies > this.limitBytes - this.usedBytes) {
      this.addBytes(text.length * copies);
    }
    this.addBytes(estimateJsonBytes(text) * copies);
  }
}
