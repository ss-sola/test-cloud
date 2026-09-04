import type { RELEASE_AUTOMATION_VERSION } from './release-automation.constants';

export type ReleaseVersion = typeof RELEASE_AUTOMATION_VERSION;
export type ReleaseMode = 'dry-run' | 'apply';

export interface ReleaseUnit {
  repository: string;
  targetBranch: string;
  candidateSha: string;
  version: ReleaseVersion;
}

export interface ReleasePlanInput {
  repository?: string;
  targetBranch: string;
  candidateSha: string;
  version?: string;
  mode?: ReleaseMode;
}

export interface ReleasePlanPayload {
  releaseUnit: ReleaseUnit;
  mode: 'dry-run';
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

export interface ReleaseProgress {
  stage: ReleaseStage;
  sequence: number;
  percent: number;
  message: string;
  updatedAt: string;
  releaseUnit: ReleaseUnit;
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
  mode: 'dry-run';
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

export interface ReleaseJobStatusView extends ReleaseJobRecord {
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
}

export interface JenkinsReleaseOptions {
  releaseUnit: ReleaseUnit;
  planHash: string;
  mode: ReleaseMode;
  sideEffectGate?: string;
}

export interface JenkinsPackageResult {
  status: 'planned' | 'verified' | 'failed' | 'blocked' | 'manual-intervention';
  queueId?: string;
  buildNumber?: number;
  pipelineTag?: string;
  candidateSha?: string;
  reason?: string;
}
