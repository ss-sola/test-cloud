import { Injectable } from '@nestjs/common';
import { ProjectException } from '@nest-cloud/common';
import { GitHubApiException, GitHubReleaseClientService } from './github-release-client.service';
import { JenkinsClientService } from './jenkins-client.service';
import { ModifyLogArchiveService } from './modify-log-archive.service';
import { ModifyLogGatewayService } from './modify-log-gateway.service';
import {
  RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH,
  RELEASE_AUTOMATION_VERSION,
} from './release-automation.constants';
import type { ReleaseAutomationConfig } from './release-automation.config';
import type {
  ClearModifyLogOptions,
  GitHubRef,
  JenkinsPackageResult,
  ModifyLogArtifact,
  ReleaseMode,
  ReleasePullRequest,
  ReleaseUnit,
} from './release-automation.types';

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
  sourcePath?: string;
  sourceRef?: string;
  sourceBlobSha?: string;
  artifact: ModifyLogArtifact | null;
}

@Injectable()
export class ReleaseAutomationService {
  constructor(
    private readonly github: GitHubReleaseClientService,
    private readonly jenkins: JenkinsClientService,
    private readonly modifyLogGateway: ModifyLogGatewayService,
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

  async createOrReusePullRequest(options: {
    repository: string;
    targetBranch: string;
    sourceBranch: string;
    releaseTag?: string;
    mode: ReleaseMode;
    sideEffectGate?: string;
    config?: ReleaseAutomationConfig;
    expectedTargetSha?: string;
    expectedSourceSha?: string;
  }): Promise<{
    status: 'submitted' | 'reused' | 'planned';
    targetSha: string;
    sourceSha: string;
    targetBranch: string;
    sourceBranch: string;
    pullRequest?: ReleasePullRequest;
  }> {
    const [targetBefore, source] = await Promise.all([
      this.github.getRef(options.repository, `heads/${options.targetBranch}`, options.config),
      this.github.getRef(options.repository, `heads/${options.sourceBranch}`, options.config),
    ]);
    if (options.expectedTargetSha && targetBefore.sha !== options.expectedTargetSha) {
      throw new ProjectException('远程 PR 目标 SHA 已变化，必须重新 plan。', 409);
    }
    if (options.expectedSourceSha && source.sha !== options.expectedSourceSha) {
      throw new ProjectException('远程 PR 来源 SHA 已变化，必须重新 plan。', 409);
    }
    const baseResult = {
      targetSha: targetBefore.sha,
      sourceSha: source.sha,
      targetBranch: options.targetBranch,
      sourceBranch: options.sourceBranch,
    } as const;
    if (options.mode === 'dry-run') return { status: 'planned', ...baseResult };

    const existing = await this.findMatchingPullRequest(options, source.sha);
    if (existing) return { status: 'reused', ...baseResult, pullRequest: existing };

    const releaseTag = options.releaseTag ?? RELEASE_AUTOMATION_VERSION;
    try {
      const pullRequest = await this.github.createPullRequest({
        repository: options.repository,
        base: options.targetBranch,
        head: options.sourceBranch,
        title: `Release ${releaseTag}: ${options.sourceBranch} -> ${options.targetBranch}`,
        body: [
          '由 NestCloud 发布流程提交。',
          `来源分支：${options.sourceBranch}（${source.sha}）`,
          `目标分支：${options.targetBranch}（${targetBefore.sha}）`,
          `发布 tag：${releaseTag}`,
          'PR 合并前不会触发 Jenkins。',
        ].join('\n'),
        mode: options.mode,
        sideEffectGate: options.sideEffectGate,
        config: options.config,
      });
      if (pullRequest.headSha !== source.sha) {
        throw new ProjectException('GitHub PR 来源 SHA 已在创建期间变化，请重新 plan。', 409);
      }
      return { status: 'submitted', ...baseResult, pullRequest };
    } catch (error) {
      if (!isExistingPullRequestValidation(error)) throw error;
      const reconciled = await this.findMatchingPullRequest(options, source.sha);
      if (reconciled) return { status: 'reused', ...baseResult, pullRequest: reconciled };
      throw error;
    }
  }

  private async findMatchingPullRequest(
    options: {
      repository: string;
      targetBranch: string;
      sourceBranch: string;
      config?: ReleaseAutomationConfig;
    },
    sourceSha: string,
  ): Promise<ReleasePullRequest | undefined> {
    const pullRequests = await this.github.listPullRequests({
      repository: options.repository,
      base: options.targetBranch,
      head: options.sourceBranch,
      config: options.config,
    });
    const matches = pullRequests.filter(
      (pullRequest) =>
        pullRequest.baseBranch === options.targetBranch &&
        pullRequest.headBranch === options.sourceBranch,
    );
    if (matches.length > 1)
      throw new ProjectException('同一来源和目标分支存在多个 open PR，请先人工清理。', 409);
    const existing = matches[0];
    if (existing && existing.headSha !== sourceSha) {
      throw new ProjectException('已有 PR 的来源 SHA 已过期，请先在 GitHub 处理该 PR。', 409);
    }
    return existing;
  }

  async prepareModifyLog(options: {
    releaseUnit: ReleaseUnit;
    mode: ReleaseMode;
    config: ReleaseAutomationConfig;
    jobId?: string;
  }): Promise<ModifyLogPreparation> {
    const source = await this.modifyLogGateway.readSource({
      repository: options.releaseUnit.repository,
      ref: options.releaseUnit.candidateSha ?? RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH,
      config: options.config,
    });
    const sql = source.content;
    return {
      sourceChecksum: source.checksum,
      generation: source.generation,
      recordCount: source.records.length,
      sql,
      sourcePath: source.path,
      sourceRef: source.ref,
      sourceBlobSha: source.blobSha,
      artifact: null,
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
  const repository = input?.trim();
  if (!repository) throw new ProjectException('必须指定 GitHub repository。', 400);
  return normalizeRepository(repository);
}

function isExistingPullRequestValidation(error: unknown): error is GitHubApiException {
  return (
    error instanceof GitHubApiException &&
    error.getStatus() === 422 &&
    error.detail?.toLowerCase().includes('pull request already exists') === true
  );
}

function normalizeRepository(value: string): string {
  const input = value
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  const slug = /^https:\/\/github\.com\//i.test(input)
    ? input.replace(/^https:\/\/github\.com\//i, '')
    : input;
  return slug.toLowerCase();
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
