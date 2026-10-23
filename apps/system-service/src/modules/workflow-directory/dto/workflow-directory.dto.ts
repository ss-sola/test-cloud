import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import {
  WORKFLOW_DIRECTORY_LIMITS,
  WORKFLOW_DIRECTORY_REVISION_PATTERN,
} from '../../../constants/workflow-directory.constants';

/** 原样读取字段，避免全局隐式转换把非字符串值转成字符串后绕过校验。 */
const rawValue = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key];

/** 读取单个工作流文件的 query 参数。 */
export class WorkflowDirectoryFileQueryDto {
  @Transform(rawValue)
  @IsString()
  @MaxLength(WORKFLOW_DIRECTORY_LIMITS.maxFilenameLength)
  filename!: string;
}

/** 保存请求：三个字段全部必传，expectedRevision 为 null 表示新建。 */
export class WorkflowDirectorySaveDto {
  @Transform(rawValue)
  @IsString()
  @MaxLength(WORKFLOW_DIRECTORY_LIMITS.maxFilenameLength)
  filename!: string;

  @Transform(rawValue)
  @IsString()
  @MaxLength(WORKFLOW_DIRECTORY_LIMITS.maxDocumentBytes)
  text!: string;

  @Transform(rawValue)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Matches(WORKFLOW_DIRECTORY_REVISION_PATTERN)
  expectedRevision!: string | null;
}
