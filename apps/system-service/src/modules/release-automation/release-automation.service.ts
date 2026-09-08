import { Injectable } from '@nestjs/common';
import { ProjectException } from '@nest-cloud/common';
import { diffEnv } from './env-diff.util';
import { GitHubApiException, GitHubReleaseClientService } from './github-release-client.service';
import { JenkinsClientService } from './jenkins-client.service';
import { ModifyLogArchiveService } from './modify-log-archive.service';
import { ModifyLogGatewayService } from './modify-log-gateway.service';
import { readReleaseAutomationConfig } from './release-automation.config';
import { RELEASE_AUTOMATION_VERSION } from './release-automation.constants';
import { VersionSqlRenderer } from './version-sql.renderer';
import type { ReleaseAutomationConfig } from './release-automation.config';
import type {
  ClearModifyLogOptions,
  GitHubRef,
  JenkinsPackageResult,
  ModifyLogArtifact,
  ReleaseMode,
  ReleaseUnit,
} from './release-automation.types';

export interface EnvironmentDiffOptions {
  repository?: string;
}

export interface EnvironmentDiffReport {
  repository: string;
  before: GitHubRef;
  after: GitHubRef;
  filePath: string;
  diff: ReturnType<typeof diffEnv>;
}

export interface BranchPlanEntry {
  targetBranch: string;
  targetSha: string;
  sources: Array<{
    sourceBranch: 'dev' | 'master';
    sourceSha: string;
    alreadyIncluded: boolean;
    ahead?: number;
    behind?: number;
    status?: string;
  }>;
}

export interface BranchPlanReport {
  repository: string;
  targets: BranchPlanEntry[];
}

export interface ModifyLogPreparation {
  sourceChecksum: string;
  generation: string;
  recordCount: number;
  sql: string;
  artifact: ModifyLogArtifact | null;
}

@Injectable()
export class ReleaseAutomationService {
  constructor(
    private readonly github: GitHubReleaseClientService,
    private readonly jenkins: JenkinsClientService,
    private readonly modifyLogGateway: ModifyLogGatewayService,
    private readonly renderer: VersionSqlRenderer,
    private readonly archive: ModifyLogArchiveService,
  ) {}

  async ensureTag(options: {
    repository: string;
    tag: string;
    sourceBranch: string;
    mode: ReleaseMode;
    sideEffectGate: string;
    config?: ReleaseAutomationConfig;
    expectedSha?: string;
  }): Promise<{ status: 'created' | 'skipped' | 'planned' | 'reconciled'; sha: string }> {
    let existing: GitHubRef | undefined;
    try {
      existing = await this.github.getRef(
        options.repository,
        `tags/${options.tag}`,
        options.config,
      );
    } catch (error) {
      if (!(error instanceof GitHubApiException) || error.getStatus() !== 404) throw error;
    }
    if (existing) return { status: 'skipped', sha: existing.sha };

    const source = await this.github.getRef(
      options.repository,
      `heads/${options.sourceBranch}`,
      options.config,
    );
    if (options.expectedSha && source.sha !== options.expectedSha) {
      throw new ProjectException('Git tag 来源 SHA 已变化，必须重新 plan。', 409);
    }
    if (options.mode === 'dry-run') return { status: 'planned', sha: source.sha };

    try {
      const created = await this.github.createTag({
        repository: options.repository,
        tag: options.tag,
        sha: source.sha,
        mode: options.mode,
        sideEffectGate: options.sideEffectGate,
        config: options.config,
      });
      return { status: 'created', sha: created.sha };
    } catch (error) {
      if (!(error instanceof GitHubApiException) || error.getStatus() !== 422) throw error;
      try {
        const reconciled = await this.github.getRef(
          options.repository,
          `tags/${options.tag}`,
          options.config,
        );
        return { status: 'reconciled', sha: reconciled.sha };
      } catch (readError) {
        if (readError instanceof GitHubApiException && readError.getStatus() === 404) throw error;
        throw readError;
      }
    }
  }

  async getBranchRef(options: {
    repository: string;
    branch: string;
    config?: ReleaseAutomationConfig;
  }): Promise<GitHubRef> {
    return this.github.getRef(options.repository, `heads/${options.branch}`, options.config);
  }
  async getEnvironmentDiff(options: EnvironmentDiffOptions = {}): Promise<EnvironmentDiffReport> {
    const config = readReleaseAutomationConfig();
    const repository = selectRepository(options.repository);
    if (
      !config.environmentBeforeRef ||
      !config.environmentAfterRef ||
      !config.environmentFilePath
    ) {
      throw new ProjectException('ENV diff 的 ref 或文件路径待配置。', 503);
    }
    const [beforeRef, afterRef] = await Promise.all([
      this.github.getRef(repository, config.environmentBeforeRef),
      this.github.getRef(repository, config.environmentAfterRef),
    ]);
    const [beforeFile, afterFile] = await Promise.all([
      this.github.getContents({ repository, path: config.environmentFilePath, ref: beforeRef.ref }),
      this.github.getContents({ repository, path: config.environmentFilePath, ref: afterRef.ref }),
    ]);
    return {
      repository,
      before: beforeRef,
      after: afterRef,
      filePath: config.environmentFilePath,
      diff: diffEnv(beforeFile.content, afterFile.content),
    };
  }

  async planBranches(options: { repository?: string } = {}): Promise<BranchPlanReport> {
    const repository = selectRepository(options.repository);
    const [dev, master, targets] = await Promise.all([
      this.github.getRef(repository, 'heads/dev'),
      this.github.getRef(repository, 'heads/master'),
      this.github.listBranches({ repository }),
    ]);
    const entries: BranchPlanEntry[] = [];
    for (const targetBranch of targets) {
      const target = await this.github.getRef(repository, `heads/${targetBranch}`);
      const sources: BranchPlanEntry['sources'] = [];
      for (const source of [
        { branch: 'dev' as const, ref: dev },
        { branch: 'master' as const, ref: master },
      ]) {
        const comparison = await this.github.compare({
          repository,
          base: targetBranch,
          head: source.branch,
        });
        const details = parseCompare(comparison);
        sources.push({
          sourceBranch: source.branch,
          sourceSha: source.ref.sha,
          alreadyIncluded: details.status === 'identical' || details.ahead === 0,
          ...details,
        });
      }
      entries.push({ targetBranch, targetSha: target.sha, sources });
    }
    return {
      repository,
      targets: entries.sort((left, right) => left.targetBranch.localeCompare(right.targetBranch)),
    };
  }

  async mergeBranch(options: {
    repository: string;
    targetBranch: string;
    sourceBranch: string;
    mode: ReleaseMode;
    sideEffectGate?: string;
    config?: ReleaseAutomationConfig;
    expectedTargetSha?: string;
    expectedSourceSha?: string;
  }) {
    if (!/^custom\/(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/.test(options.targetBranch)) {
      throw new ProjectException('远程合并目标必须是 custom/*。', 400);
    }
    const [targetBefore, source] = await Promise.all([
      this.github.getRef(options.repository, `heads/${options.targetBranch}`, options.config),
      this.github.getRef(options.repository, `heads/${options.sourceBranch}`, options.config),
    ]);
    if (options.expectedTargetSha && targetBefore.sha !== options.expectedTargetSha) {
      throw new ProjectException('远程合并目标 SHA 已变化，必须重新 plan。', 409);
    }
    if (options.expectedSourceSha && source.sha !== options.expectedSourceSha) {
      throw new ProjectException('远程合并来源 SHA 已变化，必须重新 plan。', 409);
    }
    if (options.mode === 'dry-run') {
      return {
        status: 'planned' as const,
        beforeSha: targetBefore.sha,
        afterSha: targetBefore.sha,
        sourceSha: source.sha,
        targetBranch: options.targetBranch,
        sourceBranch: options.sourceBranch,
      };
    }

    const result = await this.github.merge({
      repository: options.repository,
      base: options.targetBranch,
      head: options.sourceBranch,
      message: `Merge ${options.sourceBranch} into ${options.targetBranch} for Release Version ${RELEASE_AUTOMATION_VERSION}`,
      mode: options.mode,
      sideEffectGate: options.sideEffectGate,
      config: options.config,
    });
    const targetAfter = await this.github.getRef(
      options.repository,
      `heads/${options.targetBranch}`,
      options.config,
    );
    if (result.status === 'merged' && (!result.sha || targetAfter.sha !== result.sha)) {
      throw new ProjectException('远程合并后目标 SHA 与响应不一致。', 409);
    }
    if (result.status === 'already-applied' && targetAfter.sha !== targetBefore.sha) {
      throw new ProjectException('远程合并返回已完成但目标 SHA 发生变化。', 409);
    }
    return {
      ...result,
      beforeSha: targetBefore.sha,
      afterSha: targetAfter.sha,
      sourceSha: source.sha,
      targetBranch: options.targetBranch,
      sourceBranch: options.sourceBranch,
    };
  }

  async prepareModifyLog(options: {
    releaseUnit: ReleaseUnit;
    mode: ReleaseMode;
    jobId?: string;
  }): Promise<ModifyLogPreparation> {
    const source = await this.modifyLogGateway.readSource();
    const sql = this.renderer.render({
      version: options.releaseUnit.gitTag ?? options.releaseUnit.version,
      sourceChecksum: source.checksum,
      records: source.records,
      releaseUnit: options.releaseUnit,
    });
    const artifact =
      options.mode === 'apply'
        ? await this.archive.archive({
            source,
            sql,
            releaseUnit: options.releaseUnit,
            jobId: options.jobId,
          })
        : null;
    return {
      sourceChecksum: source.checksum,
      generation: source.generation,
      recordCount: source.records.length,
      sql,
      artifact,
    };
  }

  async clearModifyLog(options: ClearModifyLogOptions): Promise<'cleared' | 'already-cleared'> {
    return this.archive.compareAndClear(options);
  }

  async packageWithJenkins(config: ReleaseAutomationConfig): Promise<JenkinsPackageResult> {
    return this.jenkins.package(config);
  }

  async createReleaseTag(options: {
    repository: string;
    tag: string;
    sha: string;
    mode: ReleaseMode;
    sideEffectGate?: string;
  }) {
    if (options.mode !== 'apply')
      throw new ProjectException('创建 release tag 需要独立 apply gate。', 403);
    return this.github.createTag({
      repository: options.repository,
      tag: options.tag,
      sha: options.sha,
      mode: options.mode,
      sideEffectGate: options.sideEffectGate,
    });
  }
}

function selectRepository(input: string | undefined): string {
  if (!input) throw new ProjectException('必须指定 GitHub repository。', 400);
  const normalized = normalizeRepository(input);
  if (!normalized) throw new ProjectException('repository 格式无效。', 400);
  return normalized;
}

function normalizeRepository(value: string): string {
  const input = value
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  const slug = /^https:\/\/github\.com\//i.test(input)
    ? input.replace(/^https:\/\/github\.com\//i, '')
    : input;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ? slug.toLowerCase() : '';
}

function parseCompare(value: unknown): { ahead?: number; behind?: number; status?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ahead: typeof record.ahead_by === 'number' ? record.ahead_by : undefined,
    behind: typeof record.behind_by === 'number' ? record.behind_by : undefined,
    status: typeof record.status === 'string' ? record.status : undefined,
  };
}
