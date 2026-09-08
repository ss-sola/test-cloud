import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import type { ReleaseMode, ReleaseTaskKey } from '../release-automation.types';

export class CreateReleaseAutomationJobDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  repository?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  @Matches(/^custom\/(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/)
  targetBranch!: string;

  @IsOptional()
  @IsIn(['dry-run', 'apply'])
  mode?: ReleaseMode;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/)
  gitTag!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  gitAddress!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  branch!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  githubToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  jenkinsToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  jenkinsBaseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  feishuAppId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  feishuAppSecret?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(['git-tag', 'github-merge', 'jenkins', 'release-docs', 'modify-log', 'feishu'], {
    each: true,
  })
  tasks?: ReleaseTaskKey[];
}

export class GetReleaseAutomationStatusDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(96)
  @Matches(/^release-[A-Za-z0-9-]{8,80}$/)
  jobId!: string;
}
