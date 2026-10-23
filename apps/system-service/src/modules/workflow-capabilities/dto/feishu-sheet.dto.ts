import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsIn,
  IsNotEmptyObject,
  IsObject,
  ValidateNested,
} from 'class-validator';
import {
  A1_RANGE_PATTERN,
  COLUMN_NAME_PATTERN,
  VISIBLE_ASCII_PATTERN,
  WORKFLOW_CAPABILITY_LIMITS,
} from '../../../constants/workflow-capability.constants';
import type { CellInput } from '../feishu-sheet-range.util';
import { IsCellMatrix, RawText, rawValue } from './workflow-capability-dto.util';

export class FeishuRuntimeDto {
  @RawText({ min: 1, max: 256, pattern: VISIBLE_ASCII_PATTERN })
  appId!: string;

  @RawText({ min: 1, max: 512, pattern: VISIBLE_ASCII_PATTERN })
  appSecret!: string;
}

export class FeishuRowMatchDto {
  @RawText({ min: 1, max: 2, pattern: COLUMN_NAME_PATTERN })
  column!: string;

  @RawText({ max: WORKFLOW_CAPABILITY_LIMITS.feishuMaxMatchValueChars })
  value!: string;

  @Transform(rawValue)
  @IsIn(['equals', 'contains'])
  mode!: 'equals' | 'contains';
}

export class FeishuFindRowDto {
  @RawText({ min: 1, max: WORKFLOW_CAPABILITY_LIMITS.feishuMaxUrlLength })
  wikiUrl!: string;

  @RawText({ min: 5, max: 20, pattern: A1_RANGE_PATTERN })
  range!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WORKFLOW_CAPABILITY_LIMITS.feishuMaxMatches)
  @ValidateNested({ each: true })
  @Type(() => FeishuRowMatchDto)
  matches!: FeishuRowMatchDto[];

  @IsObject()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FeishuRuntimeDto)
  runtime!: FeishuRuntimeDto;
}

export class FeishuWriteCellsDto {
  @RawText({ min: 1, max: WORKFLOW_CAPABILITY_LIMITS.feishuMaxUrlLength })
  wikiUrl!: string;

  @RawText({ min: 5, max: 20, pattern: A1_RANGE_PATTERN })
  range!: string;

  @Transform(rawValue)
  @IsCellMatrix()
  values!: CellInput[][];

  /** 必须是布尔 true；字符串、数字等一律视为未确认。 */
  @Transform(rawValue)
  @Equals(true)
  confirmed!: true;

  @IsObject()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FeishuRuntimeDto)
  runtime!: FeishuRuntimeDto;
}
