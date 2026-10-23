import {
  AI_TEXT_BATCHING,
  AI_TEXT_BATCH_PROMPTS,
  WORKFLOW_CAPABILITY_LIMITS,
} from '../../constants/workflow-capability.constants';
import type { AiTextDto } from './dto/ai-text.dto';
import { WorkflowCapabilityException } from './workflow-capability.exception';

export interface AiTextPromptBatch {
  prompt: string;
  sourceIndexes: number[];
}

export interface AiTextBatchPlan {
  stage: 'direct' | 'map' | 'reduce' | 'final';
  systemPrompt?: string;
  batches: AiTextPromptBatch[];
}

interface MergePlanInput {
  materials: string[];
  instructions: string[];
  systemPrompt?: string;
  contextWindowTokens: number;
}

/** 按保守字节预算规划无损原文分片与严格收敛的材料归并，不发起模型调用。 */
export class AiTextBatchUtil {
  /** 小输入保留原请求，超预算时为每段构造独立的材料整理任务。 */
  static initialPlan(input: AiTextDto): AiTextBatchPlan {
    const context =
      input.contextWindowTokens ?? WORKFLOW_CAPABILITY_LIMITS.aiDefaultContextWindowTokens;
    const budget = this.inputBudget(context);
    const systemPrompt = input.systemPrompt?.trim() ? input.systemPrompt : undefined;
    if (Buffer.byteLength(input.prompt) + Buffer.byteLength(systemPrompt ?? '') <= budget) {
      return {
        stage: 'direct',
        systemPrompt,
        batches: [{ prompt: input.prompt, sourceIndexes: [0] }],
      };
    }
    const mapSystem = [systemPrompt, AI_TEXT_BATCH_PROMPTS.mapSystem].filter(Boolean).join('\n\n');
    const maxLabel = `分片 ${AI_TEXT_BATCHING.maxBatches}/${AI_TEXT_BATCHING.maxBatches}\n`;
    const capacity =
      budget -
      Buffer.byteLength(mapSystem) -
      Buffer.byteLength(maxLabel + AI_TEXT_BATCH_PROMPTS.mapPrefix);
    const pieces = this.splitText(input.prompt, capacity);
    return {
      stage: 'map',
      systemPrompt: mapSystem,
      batches: pieces.map((piece, index) => ({
        prompt: `分片 ${index + 1}/${pieces.length}\n${AI_TEXT_BATCH_PROMPTS.mapPrefix}${piece}`,
        sourceIndexes: [index],
      })),
    };
  }

  /** 每轮显式保留共享任务要求；单项过大或无法减少材料数量时拒绝继续调用。 */
  static mergePlan(input: MergePlanInput): AiTextBatchPlan {
    const budget = this.inputBudget(input.contextWindowTokens);
    const prefix = `${AI_TEXT_BATCH_PROMPTS.instructionPrefix}${JSON.stringify(input.instructions)}${AI_TEXT_BATCH_PROMPTS.materialPrefix}`;
    const pieces = input.materials.map((material, index) => `材料 ${index + 1}\n${material}`);
    const finalSystem = [input.systemPrompt, AI_TEXT_BATCH_PROMPTS.finalSystem]
      .filter(Boolean)
      .join('\n\n');
    const finalPrompt = prefix + pieces.join('\n\n');
    if (Buffer.byteLength(finalSystem) + Buffer.byteLength(finalPrompt) <= budget) {
      return {
        stage: 'final',
        systemPrompt: finalSystem,
        batches: [{ prompt: finalPrompt, sourceIndexes: pieces.map((_piece, index) => index) }],
      };
    }

    const reduceSystem = [input.systemPrompt, AI_TEXT_BATCH_PROMPTS.reduceSystem]
      .filter(Boolean)
      .join('\n\n');
    const capacity = budget - Buffer.byteLength(reduceSystem) - Buffer.byteLength(prefix);
    const groups: number[][] = [];
    let indexes: number[] = [];
    let bytes = 0;
    for (let index = 0; index < pieces.length; index += 1) {
      const size = Buffer.byteLength(pieces[index]);
      if (size > capacity) {
        throw new WorkflowCapabilityException(
          'AI 共享任务要求或单批材料超过归并上下文预算，请增大模型上下文或缩小输入。',
          422,
        );
      }
      const nextSize = bytes + (indexes.length ? 2 : 0) + size;
      if (indexes.length && nextSize > capacity) {
        groups.push(indexes);
        indexes = [];
        bytes = 0;
      }
      bytes += (indexes.length ? 2 : 0) + size;
      indexes.push(index);
    }
    if (indexes.length) groups.push(indexes);
    if (groups.length >= pieces.length) {
      throw new WorkflowCapabilityException(
        'AI 归并无法在上下文预算内继续缩小材料，已停止调用。',
        422,
      );
    }
    return {
      stage: 'reduce',
      systemPrompt: reduceSystem,
      batches: groups.map((sourceIndexes) => ({
        prompt: prefix + sourceIndexes.map((index) => pieces[index]).join('\n\n'),
        sourceIndexes,
      })),
    };
  }

  /** 优先在换行处切开，保留全部原字符且不拆开 Unicode 代理对。 */
  static splitText(text: string, capacity: number): string[] {
    const pieces: string[] = [];
    let start = 0;
    let cursor = 0;
    let bytes = 0;
    let lastBreak = -1;
    let breakBytes = 0;
    while (cursor < text.length) {
      const width = (text.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1;
      const character = text.slice(cursor, cursor + width);
      const size = Buffer.byteLength(character);
      if (bytes + size > capacity) {
        const end = lastBreak > start && breakBytes >= capacity / 2 ? lastBreak : cursor;
        if (end === start) {
          throw new WorkflowCapabilityException('AI 系统提示词及分片指令已耗尽上下文预算。', 422);
        }
        pieces.push(text.slice(start, end));
        if (pieces.length >= AI_TEXT_BATCHING.maxBatches) {
          throw new WorkflowCapabilityException(
            'AI 输入需要超过最大分批数量，请增大模型上下文或缩小输入。',
            422,
          );
        }
        start = end;
        cursor = end;
        bytes = 0;
        lastBreak = -1;
        continue;
      }
      bytes += size;
      cursor += width;
      if (character === '\n') {
        lastBreak = cursor;
        breakBytes = bytes;
      }
    }
    if (start < text.length) pieces.push(text.slice(start));
    return pieces;
  }

  /** 以 UTF-8 字节保守估算输入 Token，预留输出余量和消息封装开销。 */
  private static inputBudget(context: number): number {
    if (
      !Number.isSafeInteger(context) ||
      context < WORKFLOW_CAPABILITY_LIMITS.aiMinContextWindowTokens ||
      context > WORKFLOW_CAPABILITY_LIMITS.aiMaxContextWindowTokens
    ) {
      throw new WorkflowCapabilityException(
        '模型上下文必须是 4096 到 1000000 之间的整数 Token 数。',
        400,
      );
    }
    return (
      Math.floor(context * AI_TEXT_BATCHING.inputRatio) - AI_TEXT_BATCHING.messageOverheadTokens
    );
  }
}
