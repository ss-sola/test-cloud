import { Type } from 'class-transformer';
import { IsInt, IsNotEmptyObject, IsObject, Max, Min, ValidateNested } from 'class-validator';
import {
  ISO_DATE_TIME_PATTERN,
  NO_CONTROL_CHARACTER_PATTERN,
  VISIBLE_ASCII_PATTERN,
  WORKFLOW_CAPABILITY_LIMITS,
} from '../../../constants/workflow-capability.constants';
import { RawText } from './workflow-capability-dto.util';

export class GithubRuntimeDto {
  @RawText({ min: 1, max: 4096, pattern: VISIBLE_ASCII_PATTERN })
  githubToken!: string;
}

export class GithubCommitsDto {
  @RawText({ min: 1, max: WORKFLOW_CAPABILITY_LIMITS.githubMaxRepositoryLength })
  repository!: string;

  @RawText({
    optional: true,
    max: WORKFLOW_CAPABILITY_LIMITS.githubMaxRefLength,
    pattern: NO_CONTROL_CHARACTER_PATTERN,
  })
  branch?: string;

  @RawText({
    optional: true,
    max: WORKFLOW_CAPABILITY_LIMITS.githubMaxAuthorLength,
    pattern: NO_CONTROL_CHARACTER_PATTERN,
  })
  author?: string;

  @RawText({ min: 20, max: 40, pattern: ISO_DATE_TIME_PATTERN })
  since!: string;

  @RawText({ min: 20, max: 40, pattern: ISO_DATE_TIME_PATTERN })
  until!: string;

  @IsInt()
  @Min(1)
  @Max(WORKFLOW_CAPABILITY_LIMITS.githubMaxCommits)
  maxCommits!: number;

  @IsObject()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => GithubRuntimeDto)
  runtime!: GithubRuntimeDto;
}
