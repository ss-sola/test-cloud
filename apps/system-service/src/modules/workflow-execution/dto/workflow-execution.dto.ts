import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsObject,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { WORKFLOW_EXECUTION_LIMITS } from '../../../constants/workflow-execution.constants';
import {
  IsIanaTimeZone,
  IsWithinPreviousBudget,
  IsZonedIsoDateTime,
  MaxUtf8Bytes,
  RawString,
  VISIBLE_ASCII_OR_EMPTY_PATTERN,
  rawValue,
} from './workflow-execution-dto.util';

const LIMITS = WORKFLOW_EXECUTION_LIMITS;

/**
 * 以下 DTO 先由 HTTP 边界做无隐式转换、禁止未知字段的严格校验，再进入全局 ValidationPipe。
 * 所有叶子字段都用 rawValue 读取原值，避免全局隐式转换在第二次转型时改写类型。
 */

/** AI 凭据组；字段允许缺省或为空串，是否完整由真正用到 AI 能力的执行桥接校验。 */
export class WorkflowAiRuntimeDto {
  @RawString({ optional: true, max: 2048 })
  baseUrl?: string;

  @RawString({ optional: true, max: 4096, pattern: VISIBLE_ASCII_OR_EMPTY_PATTERN })
  apiKey?: string;

  @RawString({ optional: true, max: 256, pattern: VISIBLE_ASCII_OR_EMPTY_PATTERN })
  model?: string;

  @Transform(rawValue)
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  enableThinking?: boolean;
}

/** 本次运行显式提交的凭据对象，可以为空对象。 */
export class WorkflowRuntimeDto {
  @RawString({ optional: true, max: 4096, pattern: VISIBLE_ASCII_OR_EMPTY_PATTERN })
  githubToken?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => WorkflowAiRuntimeDto)
  ai?: WorkflowAiRuntimeDto;

  @RawString({ optional: true, max: 256, pattern: VISIBLE_ASCII_OR_EMPTY_PATTERN })
  feishuAppId?: string;

  @RawString({ optional: true, max: 512, pattern: VISIBLE_ASCII_OR_EMPTY_PATTERN })
  feishuAppSecret?: string;
}

/** 日期节点使用的参考时间与时区，由调用方明确给出。 */
export class WorkflowDateContextDto {
  @RawString({ min: 20, max: 40 })
  @IsZonedIsoDateTime()
  now!: string;

  @RawString({ min: 1, max: 100 })
  @IsIanaTimeZone()
  timeZone!: string;
}

/** 局部重跑时复用的单个上游节点输出；输出端口与结构由执行核心逐节点校验。 */
export class WorkflowPreviousOutputDto {
  @RawString({ min: 1, max: 128, pattern: LIMITS.idPattern })
  nodeId!: string;

  @Transform(rawValue)
  @IsObject()
  outputs!: Record<string, unknown>;
}

/** 启动一次执行：完整文档、本次凭据，局部重跑时 fromNodeId 与 previousOutputs 必须同时出现。 */
export class WorkflowRunDto {
  @RawString({ min: 1, max: LIMITS.maxDocumentBytes })
  @MaxUtf8Bytes(LIMITS.maxDocumentBytes)
  document!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => WorkflowRuntimeDto)
  runtime!: WorkflowRuntimeDto;

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => WorkflowDateContextDto)
  dateContext?: WorkflowDateContextDto;

  @RawString({
    min: 1,
    max: 128,
    pattern: LIMITS.idPattern,
    condition: (object: WorkflowRunDto) =>
      object.fromNodeId !== undefined || object.previousOutputs !== undefined,
  })
  fromNodeId?: string;

  @ValidateIf(
    (object: WorkflowRunDto) =>
      object.fromNodeId !== undefined || object.previousOutputs !== undefined,
  )
  @IsArray()
  @ArrayMaxSize(LIMITS.maxPreviousOutputs)
  @ValidateNested({ each: true })
  @Type(() => WorkflowPreviousOutputDto)
  @IsWithinPreviousBudget()
  previousOutputs?: WorkflowPreviousOutputDto[];
}

/** 查询任务状态：可选 nodeId 仅返回该节点的完整输出。 */
export class WorkflowStatusQueryDto {
  @RawString({ min: 36, max: 36, pattern: LIMITS.runIdPattern })
  runId!: string;

  @RawString({ optional: true, min: 1, max: 128, pattern: LIMITS.idPattern })
  nodeId?: string;
}

/** 订阅任务事件流。 */
export class WorkflowEventsQueryDto {
  @RawString({ min: 36, max: 36, pattern: LIMITS.runIdPattern })
  runId!: string;
}

/** 显式停止任务。 */
export class WorkflowStopDto {
  @RawString({ min: 36, max: 36, pattern: LIMITS.runIdPattern })
  runId!: string;
}

/** 对一次待确认写入给出接受或拒绝。 */
export class WorkflowConfirmDto {
  @RawString({ min: 36, max: 36, pattern: LIMITS.runIdPattern })
  runId!: string;

  @RawString({ min: 36, max: 36, pattern: LIMITS.runIdPattern })
  confirmationId!: string;

  @Transform(rawValue)
  @IsBoolean()
  accepted!: boolean;
}
