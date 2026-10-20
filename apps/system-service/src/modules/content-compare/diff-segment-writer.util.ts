import {
  SEGMENT_OVERHEAD_BYTES,
  TEXT_ECHO_COPIES,
} from '../../constants/content-compare-internal.constants';
import type { DiffSegment } from './content-compare.types';
import type { OutputBudgetUtil } from './output-budget.util';

/** 按顺序累积分段并合并相邻同状态文本；每次追加前先累加输出预算。 */
export class DiffSegmentWriter {
  private readonly segments: DiffSegment[] = [];
  private pendingText = '';
  private pendingStatus: DiffSegment['status'] = null;
  private hasPending = false;

  constructor(private readonly budget: OutputBudgetUtil) {}

  /** 追加一段文本；空文本忽略，状态与上一段相同时合并。 */
  add(text: string, status: DiffSegment['status']): void {
    if (!text) return;
    this.budget.addText(text, TEXT_ECHO_COPIES); // 文本同时出现在回填文本和分段中
    if (this.hasPending && this.pendingStatus === status) {
      this.pendingText += text;
      return;
    }
    this.flush();
    this.budget.addBytes(SEGMENT_OVERHEAD_BYTES);
    this.pendingText = text;
    this.pendingStatus = status;
    this.hasPending = true;
  }

  /** 结束写入并返回全部分段。 */
  finish(): DiffSegment[] {
    this.flush();
    return this.segments;
  }

  private flush(): void {
    if (!this.hasPending) return;
    this.segments.push({ text: this.pendingText, status: this.pendingStatus });
    this.pendingText = '';
    this.hasPending = false;
  }
}
