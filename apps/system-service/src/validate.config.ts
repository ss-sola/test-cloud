import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { RELEASE_AUTOMATION_VERSION } from './modules/release-automation/release-automation.constants';

/**
 * system-service 的启动配置入口。
 * 发布自动化的业务配置由 release-automation.config.ts 做条件校验，缺失 Jenkins
 * 凭据或完整 Pipeline endpoint 时保持 blocked，不阻止既有管理台启动。
 */
export class SystemServiceConfig {
  @Min(1)
  @Max(65535)
  @IsInt()
  @IsOptional()
  Port?: number;

  @IsOptional()
  @IsString()
  ServiceName?: string;

  @IsOptional()
  @IsIn([RELEASE_AUTOMATION_VERSION])
  ReleaseAutomationVersion?: typeof RELEASE_AUTOMATION_VERSION;

  /** 发布自动化键登记；具体格式、默认值和条件关系由模块配置解析器校验。 */
  @IsOptional() ReleaseAutomationDryRun?: unknown;
  @IsOptional() @IsString() ReleaseAutomationGitHubBaseUrl?: string;
  @IsOptional() @IsString() ReleaseAutomationGitHubAllowedHosts?: string;
  @IsOptional() @IsString() ReleaseAutomationGitHubAllowedRepositories?: string;
  @IsOptional() @IsString() ReleaseAutomationGitHubTokenRef?: string;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationGitHubTimeoutMs?: number;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationGitHubMaxRetries?: number;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationGitHubMaxResponseBytes?: number;
  @IsOptional() @IsString() ReleaseAutomationEnvironmentBeforeRef?: string;
  @IsOptional() @IsString() ReleaseAutomationEnvironmentAfterRef?: string;
  @IsOptional() @IsString() ReleaseAutomationEnvironmentFilePath?: string;
  @IsOptional() @IsString() ReleaseAutomationModifyLogPath?: string;
  @IsOptional() @IsString() ReleaseAutomationModifyLogArchiveDir?: string;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationModifyLogMaxBytes?: number;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationModifyLogMaxLines?: number;
  @IsOptional() @IsString() ReleaseAutomationJenkinsBaseUrl?: string;
  @IsOptional() @IsString() ReleaseAutomationJenkinsTriggerPath?: string;
  @IsOptional() @IsString() ReleaseAutomationJenkinsQueuePathTemplate?: string;
  @IsOptional() @IsString() ReleaseAutomationJenkinsBuildPathTemplate?: string;
  @IsOptional() @IsString() ReleaseAutomationJenkinsPipelineTextPathTemplate?: string;
  @IsOptional() @IsString() ReleaseAutomationJenkinsCredentialRef?: string;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationJenkinsTimeoutMs?: number;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationJenkinsMaxRetries?: number;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationJenkinsPollIntervalMs?: number;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationJenkinsQueueTimeoutMs?: number;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationJenkinsBuildTimeoutMs?: number;
  @IsOptional() @Type(() => Number) @IsNumber() ReleaseAutomationJenkinsMaxResponseBytes?: number;
  @IsOptional() @IsString() ReleaseAutomationJenkinsPlatform?: string;
  @IsOptional() @IsString() ReleaseAutomationRedisUrl?: string;
  @IsOptional() @IsString() ReleaseAutomationRedisKeyPrefix?: string;
}
