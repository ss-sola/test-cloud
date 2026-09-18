export type ReleaseVersion = string;
export type ReleaseMode = 'dry-run' | 'apply';

export interface ReleaseAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ReleaseRuntimeConfig {
  ai?: ReleaseAiConfig;
  limits?: {
    aiTimeoutMs?: number;
    maxPromptCharacters?: number;
    maxOutputCharacters?: number;
    maxCommits?: number;
  };
}

export interface ReleaseDocsInput {}

export interface ReleaseDocsResult {
  status: 'planned' | 'succeeded' | 'degraded' | 'failed';
  repository: string;
  previousTag?: string;
  currentTag: string;
  previousSha?: string;
  resolvedSha: string;
  commitCount: number;
  mergeCommitCount: number;
  markdown: string;
  markdownChecksum: string;
  degraded: boolean;
  warnings: string[];
  environment?: {
    filePath: string;
    changedKeys: number;
    beforeChecksum: string;
    afterChecksum: string;
  };
  database?: {
    recordCount: number;
    sourceChecksum: string;
  };
}

export interface ReleaseModifyLogResult {
  status: 'planned' | 'archived';
  sourceChecksum: string;
  generation: string;
  recordCount: number;
  artifactId?: string;
  artifactChecksum?: string;
}

export interface ReleaseUnit {
  repository: string;
  targetBranch: string;
  gitTag?: string;
  candidateSha?: string;
  version: ReleaseVersion;
}

export type ReleaseTaskKey =
  | 'git-tag'
  | 'github-merge'
  | 'jenkins'
  | 'release-docs'
  | 'modify-log'
  | 'feishu';

export type ReleaseTaskStatus =
  | 'pending'
  | 'planned'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'blocked';

export interface ReleasePageConfig {
  gitAddress: string;
  branch: string;
  projectName?: string;
  githubToken: string;
  githubBaseUrl?: string;
  githubAllowedHosts?: string;
  githubTimeoutMs?: number;
  githubMaxRetries?: number;
  githubMaxResponseBytes?: number;
  environmentFilePath?: string;
  modifyLogPath?: string;
  modifyLogArchiveDir?: string;
  modifyLogMaxBytes?: number;
  modifyLogMaxLines?: number;
  jenkinsToken: string;
  jenkinsBaseUrl: string;
  jenkinsTagMarker?: string;
  jenkinsTimeoutMs?: number;
  jenkinsMaxRetries?: number;
  jenkinsPollIntervalMs?: number;
  jenkinsQueueTimeoutMs?: number;
  jenkinsBuildTimeoutMs?: number;
  jenkinsMaxResponseBytes?: number;
  jenkinsPlatform?: string;
  feishuAppId: string;
  feishuAppSecret: string;
}

export interface ReleasePlanInput {
  repository?: string;
  targetBranch: string;
  gitTag: string;
  candidateSha?: string;
  mode?: ReleaseMode;
  pageConfig?: ReleasePageConfig;
  runtime?: ReleaseRuntimeConfig;
  releaseDocs?: ReleaseDocsInput;
  selectedTasks?: ReleaseTaskKey[];
}

export interface ReleasePlanPayload {
  releaseUnit: ReleaseUnit;
  mode: ReleaseMode;
  payloadHash: string;
  planHash: string;
}

export type ReleaseStage =
  | 'planned'
  | 'preflight_blocked'
  | 'branch_plan_ready'
  | 'candidate_prepared'
  | 'jenkins_queued'
  | 'jenkins_running'
  | 'jenkins_trigger_unknown'
  | 'jenkins_verified'
  | 'docs_ready'
  | 'feishu_failed'
  | 'release_tag_created'
  | 'modify_log_clear_pending'
  | 'cleanup_pending'
  | 'manual_intervention'
  | 'completed'
  | 'partial-success'
  | 'failed';

export interface ReleaseLogEntry {
  sequence: number;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ReleaseProgress {
  stage: ReleaseStage;
  sequence: number;
  percent: number;
  message: string;
  updatedAt: string;
  releaseUnit: ReleaseUnit;
  taskStatuses?: Partial<Record<ReleaseTaskKey, ReleaseTaskStatus>>;
  logs?: ReleaseLogEntry[];
  releaseDocs?: ReleaseDocsResult;
  modifyLog?: ReleaseModifyLogResult;
  degraded?: boolean;
  warnings?: string[];
}

export interface ReleaseJobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ReleaseJobRecord {
  jobId: string;
  idempotencyKey: string;
  payloadHash: string;
  releaseUnit: ReleaseUnit;
  mode: ReleaseMode;
  pageConfig?: ReleasePageConfig;
  runtime?: ReleaseRuntimeConfig;
  releaseDocs?: ReleaseDocsInput;
  selectedTasks?: ReleaseTaskKey[];
  logs?: ReleaseLogEntry[];
  progress: ReleaseProgress;
  error: ReleaseJobError | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseJobCreateResult {
  jobId: string;
  status: ReleaseStage;
  progress: ReleaseProgress;
  idempotent: boolean;
  payloadHash: string;
  planHash: string;
}

export interface ReleaseJobStatusView extends Omit<ReleaseJobRecord, 'pageConfig' | 'runtime'> {
  planHash: string;
}

export interface GitHubRepository {
  owner: string;
  name: string;
  slug: string;
}

export interface GitHubRef {
  ref: string;
  sha: string;
  objectType?: string;
}

export interface GitHubCommitSummary {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
  isMerge?: boolean;
}

export type EnvDiffStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface EnvDiffEntry {
  key: string;
  status: EnvDiffStatus;
  beforeValue: string;
  afterValue: string;
  sensitive: boolean;
}

export interface EnvDiffResult {
  added: EnvDiffEntry[];
  removed: EnvDiffEntry[];
  changed: EnvDiffEntry[];
  unchanged: EnvDiffEntry[];
  beforeChecksum: string;
  afterChecksum: string;
}

export interface ModifyLogRecord {
  sequence: number;
  occurredAt?: string;
  action: 'insert' | 'update' | 'delete';
  table: string;
  values?: Record<string, string | number | boolean | null>;
  where?: Record<string, string | number | boolean | null>;
}

export interface ModifyLogSource {
  path: string;
  checksum: string;
  generation: string;
  content: string;
  records: ModifyLogRecord[];
}

export interface ModifyLogArtifact {
  archiveId: string;
  artifactId: string;
  releaseUnit: ReleaseUnit;
  sourcePath: string;
  sourceChecksum: string;
  artifactChecksum: string;
  recordCount: number;
  archivePath: string;
  clearStatus: 'eligible-to-clear' | 'cleared' | 'clear-failed';
}

export interface ClearModifyLogOptions {
  archiveId: string;
  sourcePath: string;
  sourceChecksum: string;
  generation: string;
  jobId: string;
  version: ReleaseVersion;
  confirmationToken: string;
  mode: ReleaseMode;
  config?: import('./release-automation.config').ReleaseAutomationConfig;
}

export interface JenkinsPackageResult {
  status: 'planned' | 'verified' | 'failed' | 'blocked' | 'manual-intervention';
  queueId?: string;
  buildNumber?: number;
  pipelineTag?: string;
  candidateSha?: string;
  reason?: string;
}
