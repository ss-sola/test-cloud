import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
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
  githubBaseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  githubAllowedHosts?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(300000)
  githubTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10)
  githubMaxRetries?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(10 * 1024 * 1024)
  githubMaxResponseBytes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  environmentBeforeRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  environmentAfterRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  environmentFilePath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  modifyLogPath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  modifyLogArchiveDir?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50 * 1024 * 1024)
  modifyLogMaxBytes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100000)
  modifyLogMaxLines?: number;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  jenkinsToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  jenkinsTagMarker?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(300000)
  jenkinsTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10)
  jenkinsMaxRetries?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(300000)
  jenkinsPollIntervalMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(3600000)
  jenkinsQueueTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(24 * 3600000)
  jenkinsBuildTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(10 * 1024 * 1024)
  jenkinsMaxResponseBytes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  jenkinsPlatform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  jenkinsBaseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  projectName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
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
