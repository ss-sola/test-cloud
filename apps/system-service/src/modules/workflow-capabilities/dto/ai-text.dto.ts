import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  VISIBLE_ASCII_PATTERN,
  WORKFLOW_CAPABILITY_LIMITS,
} from '../../../constants/workflow-capability.constants';
import { RawText, rawValue } from './workflow-capability-dto.util';

export class AiConfigDto {
  @RawText({ min: 1, max: 2048 })
  baseUrl!: string;

  @RawText({ min: 1, max: 4096, pattern: VISIBLE_ASCII_PATTERN })
  apiKey!: string;

  @RawText({ min: 1, max: 256, pattern: VISIBLE_ASCII_PATTERN })
  model!: string;

  @Transform(rawValue)
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  enableThinking?: boolean;
}

export class AiRuntimeDto {
  @IsObject()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => AiConfigDto)
  ai!: AiConfigDto;
}

export class AiTextDto {
  @RawText({ min: 1, max: WORKFLOW_CAPABILITY_LIMITS.aiMaxPromptChars })
  prompt!: string;

  @RawText({ optional: true, max: WORKFLOW_CAPABILITY_LIMITS.aiMaxSystemPromptChars })
  systemPrompt?: string;

  @Transform(rawValue)
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(WORKFLOW_CAPABILITY_LIMITS.aiMinContextWindowTokens)
  @Max(WORKFLOW_CAPABILITY_LIMITS.aiMaxContextWindowTokens)
  contextWindowTokens?: number;

  /** @deprecated 仅兼容旧请求；传入值被忽略，不向上游转发。 */
  @IsOptional()
  @IsInt()
  maxTokens?: number;

  @IsObject()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => AiRuntimeDto)
  runtime!: AiRuntimeDto;
}
