import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { RELEASE_AUTOMATION_VERSION } from '../release-automation.constants';
import type { ReleaseMode } from '../release-automation.types';

export class CreateReleaseAutomationJobDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  repository?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  @Matches(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/)
  targetBranch!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9a-f]{7,64}$/i)
  candidateSha!: string;

  @IsOptional()
  @IsIn([RELEASE_AUTOMATION_VERSION])
  version?: typeof RELEASE_AUTOMATION_VERSION;

  @IsOptional()
  @IsIn(['dry-run'])
  mode?: ReleaseMode;
}

export class GetReleaseAutomationStatusDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(96)
  @Matches(/^release-[A-Za-z0-9-]{8,80}$/)
  jobId!: string;
}
