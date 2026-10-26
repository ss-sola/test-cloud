import { Injectable } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import { AiTextClientException } from '../../client/ai/ai-text-client.exception';
import { WORKFLOW_EXECUTION_MESSAGES } from '../../constants/workflow-execution.constants';
import { ContentCompareService } from '../content-compare/content-compare.service';
import type { CompareContentInput } from '../content-compare/content-compare.types';
import { AiTextCapabilityService } from '../workflow-capabilities/ai-text-capability.service';
import { AiTextDto } from '../workflow-capabilities/dto/ai-text.dto';
import {
  FeishuFindRowDto,
  FeishuWriteCellsDto,
} from '../workflow-capabilities/dto/feishu-sheet.dto';
import { GithubCommitsDto } from '../workflow-capabilities/dto/github-commits.dto';
import { parseCapabilityDto } from '../workflow-capabilities/dto/workflow-capability-dto.util';
import { FeishuSheetCapabilityService } from '../workflow-capabilities/feishu-sheet-capability.service';
import { GithubCommitsCapabilityService } from '../workflow-capabilities/github-commits-capability.service';
import { WorkflowCapabilityException } from '../workflow-capabilities/workflow-capability.exception';
import { WorkflowExecutionIoService } from './workflow-execution-io.service';

interface CapabilityCall {
  kind: string;
  body: object;
  signal: AbortSignal;
  nodeId?: string;
}

/** 无 HTTP 回环的原子能力桥接；逐次校验 DTO 并隔离未知底层异常。 */
@Injectable()
export class WorkflowExecutionCapabilityService {
  constructor(
    private readonly github: GithubCommitsCapabilityService,
    private readonly ai: AiTextCapabilityService,
    private readonly feishu: FeishuSheetCapabilityService,
    private readonly contentCompare: ContentCompareService,
    private readonly io: WorkflowExecutionIoService,
  ) {}

  /** 从固定能力名分派至已有 Service；写入决定只能由当前任务的确认流程产生。 */
  async invoke(
    call: CapabilityCall,
    context: { runId: string; assertActive(): void; onWrite(nodeId: string): void },
  ): Promise<unknown> {
    const { kind, body, signal } = call;
    try {
      signal.throwIfAborted();
      context.assertActive();
      let data: unknown;
      if (kind === 'aiText') {
        const input = parseCapabilityDto(AiTextDto, body);
        if (!input) throw new WorkflowCapabilityException('本次 AI 参数不合法。', 400);
        data = await this.ai.generate(input, signal, (operation, callSignal) =>
          this.io.run({
            runId: context.runId,
            signal: callSignal,
            call: () => {
              context.assertActive();
              return operation();
            },
          }),
        );
      } else {
        data = await this.io.run({
          runId: context.runId,
          signal,
          call: async () => {
            context.assertActive();
            if (kind === 'githubCommits') {
              const input = parseCapabilityDto(GithubCommitsDto, body);
              if (!input) throw new WorkflowCapabilityException('本次 GitHub 参数不合法。', 400);
              return this.github.query(input, signal);
            }
            if (kind === 'feishuFindRow') {
              const input = parseCapabilityDto(FeishuFindRowDto, body);
              if (!input) throw new WorkflowCapabilityException('本次飞书查找参数不合法。', 400);
              return this.feishu.findRow(input, signal);
            }
            if (kind === 'feishuWriteCells') {
              const input = parseCapabilityDto(FeishuWriteCellsDto, body);
              if (!input || !call.nodeId)
                throw new WorkflowCapabilityException('本次飞书写入参数不合法。', 400);
              return this.feishu.writeCells(input, signal, () => {
                signal.throwIfAborted();
                context.assertActive();
                context.onWrite(call.nodeId!);
              });
            }
            throw new WorkflowCapabilityException('不支持的工作流能力。', 400);
          },
        });
      }
      signal.throwIfAborted();
      return ResponseUtil.success(data);
    } catch (error) {
      if (error instanceof WorkflowCapabilityException || error instanceof AiTextClientException) {
        return ResponseUtil.error(error.message, error.getStatus());
      }
      return ResponseUtil.error(WORKFLOW_EXECUTION_MESSAGES.failed, 502);
    }
  }

  /** 即时计算并转换为安全的节点错误，不将原始解析异常或输入带入执行状态。 */
  compare(input: CompareContentInput & { signal?: AbortSignal }) {
    input.signal?.throwIfAborted();
    try {
      return this.contentCompare.compare(input);
    } catch {
      throw new Error('内容对比失败，请检查两侧内容格式及大小。');
    }
  }
}
