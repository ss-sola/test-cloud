import { describe, expect, it, vi } from 'vitest';
import { ReleaseAutomationExecutionService } from '../modules/release-automation/release-automation-execution.service';
import type { ReleaseAutomationService } from '../modules/release-automation/release-automation.service';
import type {
  ReleaseJobRecord,
  ReleaseProgress,
  ReleaseTaskKey,
} from '../modules/release-automation/release-automation.types';

const targetSha = 'a'.repeat(40);
const sourceSha = 'b'.repeat(40);

function createRecord(
  mode: 'dry-run' | 'apply',
  selectedTasks: ReleaseTaskKey[] = ['git-tag', 'github-merge'],
): ReleaseJobRecord {
  const now = new Date(0).toISOString();
  return {
    jobId: 'release-' + '1'.repeat(48),
    idempotencyKey: 'release-execution-test-001',
    payloadHash: 'e'.repeat(64),
    releaseUnit: {
      repository: 'acme/project',
      targetBranch: 'custom/prod',
      gitTag: 'release/版本 tag',
      version: '1.9.0',
    },
    mode,
    pageConfig: {
      gitAddress: 'https://github.com/acme/project.git',
      branch: 'custom/prod',
      githubToken: '',
      jenkinsToken: '',
      jenkinsBaseUrl: '',
      feishuAppId: '',
      feishuAppSecret: '',
    },
    selectedTasks,
    releaseDocs: {},
    progress: {
      stage: 'planned',
      sequence: 0,
      percent: 0,
      message: 'queued',
      updatedAt: now,
      releaseUnit: {
        repository: 'acme/project',
        targetBranch: 'custom/prod',
        gitTag: 'release/版本 tag',
        version: '1.9.0',
      },
    },
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createFakeService() {
  const pullRequestCalls: Array<{
    sourceBranch: string;
    targetBranch: string;
    expectedTargetSha?: string;
    expectedSourceSha?: string;
    mode: 'dry-run' | 'apply';
  }> = [];
  const pullRequest = {
    number: 42,
    url: 'https://github.com/acme/project/pull/42',
    title: 'Release 1.9.0',
    state: 'open' as const,
    baseBranch: 'custom/prod',
    headBranch: 'dev/master',
    headSha: sourceSha,
  };
  const fake = {
    ensureTag: vi.fn().mockResolvedValue({ status: 'created', sha: sourceSha }),
    getBranchRef: vi.fn(({ branch }: { branch: string }) => {
      const sha = branch === 'custom/prod' ? targetSha : sourceSha;
      return Promise.resolve({ ref: `refs/heads/${branch}`, sha });
    }),
    createOrReusePullRequest: vi.fn(
      (options: {
        sourceBranch: string;
        targetBranch: string;
        expectedTargetSha?: string;
        expectedSourceSha?: string;
        mode: 'dry-run' | 'apply';
      }) => {
        pullRequestCalls.push(options);
        return Promise.resolve({
          status: options.mode === 'dry-run' ? ('planned' as const) : ('submitted' as const),
          targetSha,
          sourceSha,
          targetBranch: options.targetBranch,
          sourceBranch: options.sourceBranch,
          ...(options.mode === 'apply' ? { pullRequest } : {}),
        });
      },
    ),
    packageWithJenkins: vi.fn(),
    prepareModifyLog: vi.fn().mockResolvedValue({
      sourceChecksum: 'a'.repeat(64),
      generation: 'generation',
      recordCount: 0,
      sql: '-- sql',
      artifact: null,
    }),
  };
  return { fake, pullRequestCalls, pullRequest };
}

function createFakeDocsService() {
  return {
    generate: vi.fn().mockResolvedValue({
      status: 'degraded',
      repository: 'acme/project',
      previousTag: 'release/previous',
      currentTag: 'release/版本 tag',
      previousSha: 'c'.repeat(40),
      resolvedSha: 'd'.repeat(40),
      commitCount: 1,
      mergeCommitCount: 0,
      markdown: '# 发布说明\n',
      markdownChecksum: 'f'.repeat(64),
      degraded: true,
      warnings: ['test fallback'],
    }),
  };
}

describe('release automation Git execution', () => {
  it('submits a PR after the tag and stops apply before post-merge steps', async () => {
    const { fake, pullRequestCalls, pullRequest } = createFakeService();
    const docs = createFakeDocsService();
    const service = new ReleaseAutomationExecutionService(
      fake as unknown as ReleaseAutomationService,
      docs as never,
    );
    const record = createRecord('apply');
    const progress: ReleaseProgress[] = [];

    const error = await service.execute(record, async (next) => {
      progress.push(next);
    });

    expect(error).toBeNull();
    expect(docs.generate).not.toHaveBeenCalled();
    expect(fake.packageWithJenkins).not.toHaveBeenCalled();
    expect(fake.prepareModifyLog).not.toHaveBeenCalled();
    expect(fake.ensureTag).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: 'dev/master',
        mode: 'apply',
      }),
    );
    expect(pullRequestCalls.map(({ sourceBranch }) => sourceBranch)).toEqual(['dev/master']);
    expect(pullRequestCalls[0]).toMatchObject({
      expectedTargetSha: targetSha,
      expectedSourceSha: sourceSha,
      mode: 'apply',
    });
    expect(progress.at(-1)).toMatchObject({
      stage: 'manual_intervention',
      percent: 35,
      pullRequest,
    });
    expect(progress.at(-1)?.stage).not.toBe('completed');
    const logText = progress
      .flatMap((item) => item.logs ?? [])
      .map((entry) => entry.message)
      .join('\n');
    expect(logText).toContain('开始：初始化任务');
    expect(logText).toContain('完成：执行 Git tag');
    expect(logText).toContain('GitHub PR：submitted');
    expect(logText).not.toContain('runtime-token');
  });

  it('stops post-PR steps when GitHub reports a merge conflict', async () => {
    const { fake, pullRequest } = createFakeService();
    Object.assign(pullRequest, { mergeable: false, mergeableState: 'dirty' });
    const docs = createFakeDocsService();
    const service = new ReleaseAutomationExecutionService(
      fake as unknown as ReleaseAutomationService,
      docs as never,
    );
    const record = createRecord('apply');
    const progress: ReleaseProgress[] = [];

    const error = await service.execute(record, async (next) => {
      progress.push(next);
    });

    expect(error).toBeNull();
    expect(record.error).toBeNull();
    expect(fake.packageWithJenkins).not.toHaveBeenCalled();
    expect(fake.prepareModifyLog).not.toHaveBeenCalled();
    expect(docs.generate).not.toHaveBeenCalled();
    expect(progress.at(-1)).toMatchObject({
      stage: 'manual_intervention',
      taskStatuses: { 'github-merge': 'blocked' },
    });
    expect(progress.at(-1)?.message).toContain('合并冲突');
    expect(progress.at(-1)?.message).toContain('拒绝继续执行');
  });

  it('does not treat GitHub mergeability unknown as a conflict', async () => {
    const { fake, pullRequest } = createFakeService();
    Object.assign(pullRequest, { mergeable: null, mergeableState: 'unknown' });
    const docs = createFakeDocsService();
    const service = new ReleaseAutomationExecutionService(
      fake as unknown as ReleaseAutomationService,
      docs as never,
    );
    const record = createRecord('apply');
    const progress: ReleaseProgress[] = [];

    const error = await service.execute(record, async (next) => {
      progress.push(next);
    });

    expect(error).toBeNull();
    expect(progress.at(-1)).toMatchObject({
      stage: 'manual_intervention',
      taskStatuses: { 'github-merge': 'succeeded' },
    });
    expect(progress.at(-1)?.message).not.toContain('合并冲突');
  });
  it('keeps dry-run Git steps planned and never asks for apply mode', async () => {
    const { fake, pullRequestCalls } = createFakeService();
    const docs = createFakeDocsService();
    fake.ensureTag.mockResolvedValue({ status: 'planned', sha: sourceSha });
    fake.createOrReusePullRequest.mockImplementation((options) => {
      pullRequestCalls.push(options);
      return Promise.resolve({
        status: 'planned' as const,
        targetSha,
        sourceSha: options.expectedSourceSha ?? sourceSha,
        targetBranch: options.targetBranch,
        sourceBranch: options.sourceBranch,
      });
    });
    const service = new ReleaseAutomationExecutionService(
      fake as unknown as ReleaseAutomationService,
      docs as never,
    );
    const record = createRecord('dry-run');
    const progress: ReleaseProgress[] = [];

    const error = await service.execute(record, async (next) => {
      progress.push(next);
    });

    expect(error).toBeNull();
    expect(docs.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        publish: { mode: 'dry-run', sideEffectGate: record.idempotencyKey },
      }),
    );
    expect(fake.ensureTag).toHaveBeenCalledWith(expect.objectContaining({ mode: 'dry-run' }));
    expect(pullRequestCalls).toHaveLength(1);
    expect(pullRequestCalls.every(({ mode }) => mode === 'dry-run')).toBe(true);
    expect(progress.at(-1)).toMatchObject({ stage: 'completed', percent: 100 });
    expect(progress.at(-1)?.taskStatuses).toMatchObject({
      'git-tag': 'planned',
      'github-merge': 'planned',
    });
  });

  it('blocks the target when PR submission fails', async () => {
    const { fake, pullRequestCalls } = createFakeService();
    const docs = createFakeDocsService();
    fake.createOrReusePullRequest.mockRejectedValueOnce(new Error('GitHub PR has conflicts'));
    const service = new ReleaseAutomationExecutionService(
      fake as unknown as ReleaseAutomationService,
      docs as never,
    );
    const record = createRecord('apply');
    const progress: ReleaseProgress[] = [];

    const error = await service.execute(record, async (next) => {
      progress.push(next);
    });

    expect(error).toMatchObject({ code: 'GITHUB_PR_FAILED', retryable: false });
    expect(fake.createOrReusePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'dev/master', targetBranch: 'custom/prod' }),
    );
    expect(progress.at(-1)).toMatchObject({
      stage: 'preflight_blocked',
      taskStatuses: { 'git-tag': 'succeeded', 'github-merge': 'blocked' },
    });
    expect(progress.at(-1)?.stage).not.toBe('completed');
  });
});
