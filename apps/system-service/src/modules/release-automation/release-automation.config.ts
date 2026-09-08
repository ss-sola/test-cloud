import { getConfig, ProjectException } from '@nest-cloud/common';
import {
  RELEASE_AUTOMATION_DEFAULT_ARCHIVE_DIR,
  RELEASE_AUTOMATION_DEFAULT_BUILD_TIMEOUT_MS,
  RELEASE_AUTOMATION_DEFAULT_MAX_LOG_BYTES,
  RELEASE_AUTOMATION_DEFAULT_MAX_LOG_LINES,
  RELEASE_AUTOMATION_DEFAULT_MAX_RESPONSE_BYTES,
  RELEASE_AUTOMATION_DEFAULT_MAX_RETRIES,
  RELEASE_AUTOMATION_DEFAULT_POLL_INTERVAL_MS,
  RELEASE_AUTOMATION_DEFAULT_QUEUE_TIMEOUT_MS,
  RELEASE_AUTOMATION_DEFAULT_TIMEOUT_MS,
  RELEASE_AUTOMATION_QUEUE_PREFIX,
  RELEASE_AUTOMATION_VERSION,
  ReleaseAutomationConfigKeys,
} from './release-automation.constants';
import { isSecretReference } from './release-automation.security';
import type { ReleasePageConfig } from './release-automation.types';

export interface ReleaseAutomationConfig {
  version: typeof RELEASE_AUTOMATION_VERSION;
  githubBaseUrl: string;
  githubAllowedHosts: string[];
  githubTokenRef?: string;
  githubToken?: string;
  githubTimeoutMs: number;
  githubMaxRetries: number;
  githubMaxResponseBytes: number;
  environmentBeforeRef?: string;
  environmentAfterRef?: string;
  environmentFilePath?: string;
  modifyLogPath: string;
  modifyLogArchiveDir: string;
  modifyLogMaxBytes: number;
  modifyLogMaxLines: number;
  jenkinsBaseUrl?: string;
  jenkinsTriggerPath?: string;
  jenkinsQueuePathTemplate?: string;
  jenkinsBuildPathTemplate?: string;
  jenkinsPipelineTextPathTemplate?: string;
  jenkinsCredentialRef?: string;
  jenkinsToken?: string;
  jenkinsProjectName?: string;
  jenkinsBranch?: string;
  jenkinsTimeoutMs: number;
  jenkinsMaxRetries: number;
  jenkinsPollIntervalMs: number;
  jenkinsQueueTimeoutMs: number;
  jenkinsBuildTimeoutMs: number;
  jenkinsMaxResponseBytes?: number;
  jenkinsPlatform?: string;
  redisUrl?: string;
  redisKeyPrefix: string;
}

export function readReleaseAutomationConfig(
  overrides?: ReleasePageConfig,
): ReleaseAutomationConfig {
  const config: ReleaseAutomationConfig = {
    version: readVersion(),
    githubBaseUrl: readBaseUrl(
      getConfig<string>(ReleaseAutomationConfigKeys.GitHubBaseUrl, 'https://api.github.com', false),
      'GitHub',
    ),
    githubAllowedHosts: readList(ReleaseAutomationConfigKeys.GitHubAllowedHosts, 'api.github.com'),
    githubTokenRef: readOptional(ReleaseAutomationConfigKeys.GitHubTokenRef),
    githubTimeoutMs: readPositiveNumber(
      ReleaseAutomationConfigKeys.GitHubTimeoutMs,
      RELEASE_AUTOMATION_DEFAULT_TIMEOUT_MS,
    ),
    githubMaxRetries: readNonNegativeInteger(
      ReleaseAutomationConfigKeys.GitHubMaxRetries,
      RELEASE_AUTOMATION_DEFAULT_MAX_RETRIES,
    ),
    githubMaxResponseBytes: readPositiveNumber(
      ReleaseAutomationConfigKeys.GitHubMaxResponseBytes,
      RELEASE_AUTOMATION_DEFAULT_MAX_RESPONSE_BYTES,
    ),
    environmentBeforeRef: readOptional(ReleaseAutomationConfigKeys.EnvironmentBeforeRef),
    environmentAfterRef: readOptional(ReleaseAutomationConfigKeys.EnvironmentAfterRef),
    environmentFilePath: readOptional(ReleaseAutomationConfigKeys.EnvironmentFilePath),
    modifyLogPath: readOptional(ReleaseAutomationConfigKeys.ModifyLogPath) ?? 'modify-log.sql',
    modifyLogArchiveDir:
      readOptional(ReleaseAutomationConfigKeys.ModifyLogArchiveDir) ??
      RELEASE_AUTOMATION_DEFAULT_ARCHIVE_DIR,
    modifyLogMaxBytes: readPositiveNumber(
      ReleaseAutomationConfigKeys.ModifyLogMaxBytes,
      RELEASE_AUTOMATION_DEFAULT_MAX_LOG_BYTES,
    ),
    modifyLogMaxLines: readPositiveInteger(
      ReleaseAutomationConfigKeys.ModifyLogMaxLines,
      RELEASE_AUTOMATION_DEFAULT_MAX_LOG_LINES,
    ),
    jenkinsBaseUrl: readOptionalBaseUrl(ReleaseAutomationConfigKeys.JenkinsBaseUrl),
    jenkinsTriggerPath: readPath(ReleaseAutomationConfigKeys.JenkinsTriggerPath),
    jenkinsQueuePathTemplate: readPath(ReleaseAutomationConfigKeys.JenkinsQueuePathTemplate),
    jenkinsBuildPathTemplate: readPath(ReleaseAutomationConfigKeys.JenkinsBuildPathTemplate),
    jenkinsPipelineTextPathTemplate: readPath(
      ReleaseAutomationConfigKeys.JenkinsPipelineTextPathTemplate,
    ),
    jenkinsCredentialRef: readOptional(ReleaseAutomationConfigKeys.JenkinsCredentialRef),
    jenkinsTimeoutMs: readPositiveNumber(
      ReleaseAutomationConfigKeys.JenkinsTimeoutMs,
      RELEASE_AUTOMATION_DEFAULT_TIMEOUT_MS,
    ),
    jenkinsMaxRetries: readNonNegativeInteger(
      ReleaseAutomationConfigKeys.JenkinsMaxRetries,
      RELEASE_AUTOMATION_DEFAULT_MAX_RETRIES,
    ),
    jenkinsPollIntervalMs: readPositiveNumber(
      ReleaseAutomationConfigKeys.JenkinsPollIntervalMs,
      RELEASE_AUTOMATION_DEFAULT_POLL_INTERVAL_MS,
    ),
    jenkinsQueueTimeoutMs: readPositiveNumber(
      ReleaseAutomationConfigKeys.JenkinsQueueTimeoutMs,
      RELEASE_AUTOMATION_DEFAULT_QUEUE_TIMEOUT_MS,
    ),
    jenkinsBuildTimeoutMs: readPositiveNumber(
      ReleaseAutomationConfigKeys.JenkinsBuildTimeoutMs,
      RELEASE_AUTOMATION_DEFAULT_BUILD_TIMEOUT_MS,
    ),
    jenkinsMaxResponseBytes: readPositiveNumber(
      ReleaseAutomationConfigKeys.JenkinsMaxResponseBytes,
      RELEASE_AUTOMATION_DEFAULT_MAX_RESPONSE_BYTES,
    ),
    jenkinsPlatform: readOptional(ReleaseAutomationConfigKeys.JenkinsPlatform),
    redisUrl: readOptional(ReleaseAutomationConfigKeys.RedisUrl),
    redisKeyPrefix:
      readOptional(ReleaseAutomationConfigKeys.RedisKeyPrefix) ?? RELEASE_AUTOMATION_QUEUE_PREFIX,
  };

  applyPageOverrides(config, overrides);
  validateReleaseAutomationConfig(config);
  return config;
}

function applyPageOverrides(config: ReleaseAutomationConfig, overrides?: ReleasePageConfig): void {
  if (!overrides) return;
  config.githubToken = overrides.githubToken.trim() || undefined;
  config.jenkinsToken = overrides.jenkinsToken.trim() || undefined;
  config.jenkinsProjectName = overrides.projectName?.trim() || undefined;
  config.jenkinsBranch = overrides.branch.trim() || undefined;
  const jenkinsJob = overrides.jenkinsBaseUrl.trim()
    ? parseJenkinsJobUrl(overrides.jenkinsBaseUrl.trim())
    : undefined;
  config.jenkinsBaseUrl = jenkinsJob?.baseUrl ?? config.jenkinsBaseUrl;
  if (jenkinsJob) {
    config.jenkinsTriggerPath = `${jenkinsJob.jobPath}/buildWithParameters`;
    config.jenkinsQueuePathTemplate = '/queue/item/{queueId}/api/json';
    config.jenkinsBuildPathTemplate = `${jenkinsJob.jobPath}/{buildNumber}/api/json`;
    config.jenkinsPipelineTextPathTemplate = `${jenkinsJob.jobPath}/{buildNumber}/consoleText`;
  } else if (config.jenkinsProjectName) {
    const jobPath = encodeJenkinsJobPath(config.jenkinsProjectName);
    config.jenkinsTriggerPath ??= `/job/${jobPath}/buildWithParameters`;
    config.jenkinsQueuePathTemplate ??= '/queue/item/{queueId}/api/json';
    config.jenkinsBuildPathTemplate ??= `/job/${jobPath}/{buildNumber}/api/json`;
  }
}

export interface JenkinsJobAddress {
  baseUrl: string;
  jobPath: string;
}

export function parseJenkinsJobUrl(value: string): JenkinsJobAddress {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProjectException('Jenkins 任务地址无效。', 400);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ProjectException('Jenkins 任务地址必须是无凭据、无查询参数的 HTTP(S) 地址。', 400);
  }
  const rawSegments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  const segments =
    rawSegments.at(-1) === 'buildWithParameters' ? rawSegments.slice(0, -1) : rawSegments;
  if (
    segments.length < 2 ||
    segments.length % 2 !== 0 ||
    segments.some((segment, index) =>
      index % 2 === 0 ? segment !== 'job' : !isSafeJenkinsPathSegment(segment),
    )
  ) {
    throw new ProjectException('Jenkins 任务地址必须包含 /job/{name} 路径。', 400);
  }
  return {
    baseUrl: `${url.origin}`,
    jobPath: `/${segments.join('/')}`,
  };
}

function isSafeJenkinsPathSegment(value: string): boolean {
  return (
    Boolean(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..') &&
    /^[A-Za-z0-9._~!$&'()*+,;=:@%~-]+$/.test(value)
  );
}

function encodeJenkinsJobPath(value: string): string {
  if (
    !/^[A-Za-z0-9._/-]+$/.test(value) ||
    value.includes('..') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    throw new ProjectException('Jenkins 项目名称无效。', 400);
  }
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function validateReleaseAutomationConfig(config: ReleaseAutomationConfig): void {
  if (config.version !== RELEASE_AUTOMATION_VERSION) {
    throw new ProjectException(`发布版本必须固定为 ${RELEASE_AUTOMATION_VERSION}。`, 500);
  }
  if (!config.redisKeyPrefix || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(config.redisKeyPrefix)) {
    throw new ProjectException('发布自动化 Redis key prefix 配置无效。', 500);
  }
  if (config.githubAllowedHosts.length === 0) {
    throw new ProjectException('GitHub API host allowlist 不能为空。', 500);
  }
  if (!config.githubAllowedHosts.includes(new URL(config.githubBaseUrl).hostname.toLowerCase())) {
    throw new ProjectException('GitHub API base URL 不在 host allowlist。', 500);
  }
  for (const host of config.githubAllowedHosts) {
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        host,
      )
    ) {
      throw new ProjectException('GitHub host allowlist 配置无效。', 500);
    }
  }
  if (config.githubTokenRef && !isSecretReference(config.githubTokenRef)) {
    throw new ProjectException('GitHub 凭据必须使用 secret:// 引用。', 500);
  }
  if (config.jenkinsCredentialRef && !isSecretReference(config.jenkinsCredentialRef)) {
    throw new ProjectException('Jenkins 凭据必须使用 secret:// 引用。', 500);
  }
  validateJenkinsPaths(config);
}

export function isJenkinsReady(config: ReleaseAutomationConfig): boolean {
  return Boolean(
    config.jenkinsBaseUrl &&
    config.jenkinsTriggerPath &&
    config.jenkinsQueuePathTemplate &&
    config.jenkinsBuildPathTemplate &&
    config.jenkinsPipelineTextPathTemplate &&
    (config.jenkinsCredentialRef || config.jenkinsToken),
  );
}

function validateJenkinsPaths(config: ReleaseAutomationConfig): void {
  const paths = [
    config.jenkinsTriggerPath,
    config.jenkinsQueuePathTemplate,
    config.jenkinsBuildPathTemplate,
    config.jenkinsPipelineTextPathTemplate,
  ].filter((value): value is string => Boolean(value));
  if (!config.jenkinsBaseUrl && paths.length > 0) {
    throw new ProjectException('Jenkins 路径已配置但缺少 base URL。', 500);
  }
  if (
    config.jenkinsBaseUrl &&
    config.jenkinsTriggerPath &&
    !config.jenkinsTriggerPath.endsWith('/buildWithParameters')
  ) {
    throw new ProjectException('Jenkins trigger path 必须指向 buildWithParameters。', 500);
  }
  if (
    config.jenkinsBaseUrl &&
    config.jenkinsQueuePathTemplate &&
    !config.jenkinsQueuePathTemplate.includes('{queueId}')
  ) {
    throw new ProjectException('Jenkins queue path 必须包含 queueId 占位符。', 500);
  }
  if (
    config.jenkinsBaseUrl &&
    config.jenkinsBuildPathTemplate &&
    !config.jenkinsBuildPathTemplate.includes('{buildNumber}')
  ) {
    throw new ProjectException('Jenkins build path 必须包含 buildNumber 占位符。', 500);
  }
  if (
    config.jenkinsBaseUrl &&
    config.jenkinsPipelineTextPathTemplate &&
    !config.jenkinsPipelineTextPathTemplate.includes('{buildNumber}')
  ) {
    throw new ProjectException('Jenkins Pipeline text path 必须包含 buildNumber 占位符。', 500);
  }
}

function readVersion(): typeof RELEASE_AUTOMATION_VERSION {
  const configured = getConfig<string>(
    ReleaseAutomationConfigKeys.Version,
    RELEASE_AUTOMATION_VERSION,
    false,
  ).trim();
  if (configured !== RELEASE_AUTOMATION_VERSION) {
    throw new ProjectException(`发布版本必须固定为 ${RELEASE_AUTOMATION_VERSION}。`, 500);
  }
  return RELEASE_AUTOMATION_VERSION;
}

function readOptional(key: string): string | undefined {
  const value = getConfig<string>(key, '', false).trim();
  return value || undefined;
}

function readOptionalBaseUrl(key: string): string | undefined {
  const value = readOptional(key);
  return value ? readBaseUrl(value, 'Jenkins', true) : undefined;
}

function readBaseUrl(value: string, label: string, allowHttp = false): string {
  const normalized = value.trim().replace(/\/$/, '');
  try {
    const url = new URL(normalized);
    if (
      (!allowHttp && url.protocol !== 'https:') ||
      (allowHttp && url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('unsafe url');
    }
    if (url.pathname !== '/') throw new Error('base path is not allowed');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new ProjectException(`${label} API base URL 配置无效。`, 500);
  }
}

function readList(key: string, fallback: string): string[] {
  const value = getConfig<string>(key, fallback, false).trim();
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error('not string array');
      }
      return parsed
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.toLowerCase());
    } catch {
      throw new ProjectException(`配置必须是字符串数组：${key}。`, 500);
    }
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.toLowerCase());
}

function readPath(key: string): string | undefined {
  const value = readOptional(key);
  if (!value) return undefined;
  if (
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/{}-]+$/.test(value) ||
    value.includes('..') ||
    value.includes('://')
  ) {
    throw new ProjectException(`配置路径无效：${key}。`, 500);
  }
  return value;
}

function readPositiveNumber(key: string, fallback: number): number {
  const value = getConfig<number>(key, fallback, false);
  if (!Number.isFinite(value) || value <= 0)
    throw new ProjectException(`配置必须为正数：${key}。`, 500);
  return value;
}

function readPositiveInteger(key: string, fallback: number): number {
  const value = readPositiveNumber(key, fallback);
  if (!Number.isInteger(value)) throw new ProjectException(`配置必须为正整数：${key}。`, 500);
  return value;
}

function readNonNegativeInteger(key: string, fallback: number): number {
  const value = getConfig<number>(key, fallback, false);
  if (!Number.isInteger(value) || value < 0)
    throw new ProjectException(`配置必须为非负整数：${key}。`, 500);
  return value;
}
