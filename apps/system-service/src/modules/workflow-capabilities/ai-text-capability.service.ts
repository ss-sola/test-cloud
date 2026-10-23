import { Injectable } from '@nestjs/common';
import { AiTextClientService } from '../../client/ai/ai-text-client.service';
import {
  AI_TEXT_BATCHING,
  WORKFLOW_CAPABILITY_LIMITS,
} from '../../constants/workflow-capability.constants';
import { AiTextBatchUtil, type AiTextBatchPlan } from './ai-text-batch.util';
import type { AiTextDto } from './dto/ai-text.dto';
import { WorkflowCapabilityException } from './workflow-capability.exception';

/** 通用文本生成：小输入原样调用，长输入有界并行整理后按原任务合并，无本地降级。 */
@Injectable()
export class AiTextCapabilityService {
  constructor(private readonly client: AiTextClientService) {}

  /** 按本次模型上下文规划调用，只有全部成功后的最终文本可成为节点输出。 */
  async generate(input: AiTextDto, signal: AbortSignal): Promise<{ text: string }> {
    signal.throwIfAborted();
    if (!input.prompt.trim()) {
      throw new WorkflowCapabilityException('prompt 不能为空。', 400);
    }
    const initial = AiTextBatchUtil.initialPlan(input);
    const { ai } = input.runtime;
    if (initial.stage === 'direct') {
      const text = await this.client.generate({
        ...ai,
        prompt: input.prompt,
        systemPrompt: initial.systemPrompt,
        signal,
      });
      signal.throwIfAborted();
      return { text };
    }

    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const mapped = await this.runBatches({ plan: initial, input }, controller);
      const instructions = [...new Set(mapped.instructions.filter((value) => value.trim()))];
      let materials = mapped.materials;
      let calls = initial.batches.length;
      for (let round = 0; round < AI_TEXT_BATCHING.maxMergeRounds; round += 1) {
        controller.signal.throwIfAborted();
        const plan = AiTextBatchUtil.mergePlan({
          materials,
          instructions,
          systemPrompt: input.systemPrompt?.trim() ? input.systemPrompt : undefined,
          contextWindowTokens:
            input.contextWindowTokens ?? WORKFLOW_CAPABILITY_LIMITS.aiDefaultContextWindowTokens,
        });
        calls += plan.batches.filter(
          (batch) => plan.stage === 'final' || batch.sourceIndexes.length > 1,
        ).length;
        if (calls > AI_TEXT_BATCHING.maxCalls) {
          throw new WorkflowCapabilityException('AI 分批调用次数超过执行预算，已停止调用。', 422);
        }
        const results = await this.runBatches({ plan, input, materials }, controller);
        if (plan.stage === 'final') return { text: results.materials[0] };
        materials = results.materials;
      }
      throw new WorkflowCapabilityException('AI 材料超过最大归并轮数，未返回部分结果。', 422);
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  /** 即时校验每批整理结果；错误中不回显模型原文。 */
  private parseMaterial(output: string): { instructions: string; content: string } {
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      throw new WorkflowCapabilityException('AI 分片整理未返回有效 JSON，未合并部分结果。', 502);
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !('instructions' in value) ||
      typeof value.instructions !== 'string' ||
      !('content' in value) ||
      typeof value.content !== 'string' ||
      (!value.instructions.trim() && !value.content.trim())
    ) {
      throw new WorkflowCapabilityException(
        'AI 分片整理缺少有效的任务要求或材料，未合并部分结果。',
        502,
      );
    }
    return { instructions: value.instructions, content: value.content };
  }

  /** 有界领取批次并保留原序；失败取消兄弟调用，取消不等待忽略信号的外部依赖。 */
  private async runBatches(
    execution: { plan: AiTextBatchPlan; input: AiTextDto; materials?: string[] },
    controller: AbortController,
  ): Promise<{ materials: string[]; instructions: string[] }> {
    const { plan, input, materials } = execution;
    const signal = controller.signal;
    signal.throwIfAborted();
    const outputs = plan.batches.map(() => '');
    const instructions = plan.batches.map(() => '');
    let next = 0;
    let totalCharacters = 0;
    let rejectCancellation!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const abort = () => rejectCancellation(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const worker = async () => {
      try {
        while (next < plan.batches.length) {
          signal.throwIfAborted();
          const index = next++;
          const batch = plan.batches[index];
          const text =
            plan.stage === 'reduce' && batch.sourceIndexes.length === 1
              ? materials![batch.sourceIndexes[0]]
              : await this.client.generate({
                  ...input.runtime.ai,
                  prompt: batch.prompt,
                  systemPrompt: plan.systemPrompt,
                  signal,
                });
          signal.throwIfAborted();
          totalCharacters += text.length;
          if (totalCharacters > WORKFLOW_CAPABILITY_LIMITS.aiMaxTextChars) {
            throw new WorkflowCapabilityException(
              'AI 分批中间结果超过总长度预算，未返回部分结果。',
              422,
            );
          }
          if (plan.stage === 'map') {
            const material = this.parseMaterial(text);
            instructions[index] = material.instructions;
            outputs[index] = material.content;
          } else outputs[index] = text;
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    };
    try {
      await Promise.race([
        Promise.all(
          Array.from(
            { length: Math.min(AI_TEXT_BATCHING.concurrency, plan.batches.length) },
            worker,
          ),
        ),
        cancelled,
      ]);
      signal.throwIfAborted();
      return { materials: outputs, instructions };
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
