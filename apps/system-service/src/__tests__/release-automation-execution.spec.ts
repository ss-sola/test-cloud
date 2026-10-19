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
      currentBranch: 'feature/release',
      targetBranch: 'custom/prod',
      gitTag: 'release/版本 tag',
      version: '1.9.0',
    },
    mode,
    pageConfig: {
      gitAddress: 'https://github.com/acme/project.git',
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
        currentBranch: 'feature/release',
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

function createFakeService(events: string[] = []) {
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
    headBranch: 'feature/release',
    headSha: sourceSha,
  };
  const modifyLogPreparation = {
    sourceChecksum: 'a'.repeat(64),
    generation: 'generation',
    recordCount: 0,
    sql: '-- sql',
    artifact: null,
  };
  const fake = {
    ensureTag: vi.fn().mockResolvedValue({ status: 'created', sha: sourceSha }),
    findMergedPullRequest: vi.fn().mockImplementation(async () => {
      events.push('merged-pr-check');
      return undefined;
    }),
    getBranchRef: vi.fn(({ branch }: { branch: string }) => {
      events.push('pr-ref');
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
        events.push('pr-submit');
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
    packageWithJenkins: vi.fn().mockResolvedValue({ status: 'verified', pipelineTag: 'build-tag' }),
    prepareModifyLog: vi.fn().mockImplementation(async () => {
      events.push('modify-log');
      return modifyLogPreparation;
    }),
  };
  return { fake, pullRequestCalls, pullRequest, modifyLogPreparation };
}

function createFakeDocsService(markdown = '# 发布说明\n', events: string[] = []) {
  return {
    generate: vi
      .fn()
      .mockImplementation(
        async ({ publish }: { publish?: { mode: 'dry-run' | 'apply' }; modifyLog?: unknown }) => {
          events.push('release-docs');
          return {
            status: 'degraded',
            repository: 'acme/project',
            previousTag: 'release/previous',
            currentTag: 'release/版本 tag',
            previousSha: 'c'.repeat(40),
            resolvedSha: 'd'.repeat(40),
            commitCount: 1,
            mergeCommitCount: 0,
            markdown,
            markdownChecksum: 'f'.repeat(64),
            degraded: true,
            warnings: ['test fallback'],
            publication: {
              status: publish?.mode === 'dry-run' ? ('planned' as const) : ('created' as const),
              path: 'update-log/release-previous-release.md',
              branch: 'feature/release',
            },
          };
        },
      ),
  };
}

describe('release automation Git execution', () => {
  it('publishes update-log before PR and stops apply before post-merge steps', async () => {
    const events: string[] = [];
    const { fake, pullRequestCalls, pullRequest, modifyLogPreparation } = createFakeService(events);
    const docs = createFakeDocsService(undefined, events);
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
    expect(docs.generate).toHaveBeenCalledOnce();
    expect(docs.generate).toHaveBeenCalledWith(
      expect.objectContaining({ modifyLog: modifyLogPreparation }),
    );
    expect(events).toEqual([
      'modify-log',
      'merged-pr-check',
      'release-docs',
      'pr-ref',
      'pr-ref',
      'pr-submit',
    ]);
    expect(record.progress.releaseDocs?.publication).toMatchObject({
      status: 'created',
      path: 'update-log/release-previous-release.md',
      branch: 'feature/release',
    });
    expect(fake.packageWithJenkins).not.toHaveBeenCalled();
    expect(fake.prepareModifyLog).toHaveBeenCalledOnce();
    expect(fake.ensureTag).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: 'feature/release',
        mode: 'apply',
      }),
    );
    expect(pullRequestCalls.map(({ sourceBranch }) => sourceBranch)).toEqual(['feature/release']);
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

  it('blocks PR work when modify-log cannot be read', async () => {
    const events: string[] = [];
    const { fake } = createFakeService(events);
    fake.prepareModifyLog.mockImplementationOnce(async () => {
      events.push('modify-log');
      throw new Error('modify-log unavailable');
    });
    const docs = createFakeDocsService(undefined, events);
    const service = new ReleaseAutomationExecutionService(
      fake as unknown as ReleaseAutomationService,
      docs as never,
    );
    const record = createRecord('apply');

    const error = await service.execute(record, async () => {});

    expect(error).toMatchObject({ code: 'MODIFY_LOG_FAILED', retryable: false });
    expect(events).toEqual(['modify-log']);
    expect(docs.generate).not.toHaveBeenCalled();
    expect(fake.findMergedPullRequest).not.toHaveBeenCalled();
    expect(fake.getBranchRef).not.toHaveBeenCalled();
    expect(fake.createOrReusePullRequest).not.toHaveBeenCalled();
    expect(record.progress.taskStatuses).toMatchObject({
      'modify-log': 'blocked',
      'github-merge': 'pending',
    });
  });

  it('stops post-PR steps when GitHub reports a merge conflict', async () => {
    const events: string[] = [];
    const { fake, pullRequest } = createFakeService(events);
    Object.assign(pullRequest, { mergeable: false, mergeableState: 'dirty' });
    const docs = createFakeDocsService(undefined, events);
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
    expect(docs.generate).toHaveBeenCalledOnce();
    expect(events).toEqual([
      'modify-log',
      'merged-pr-check',
      'release-docs',
      'pr-ref',
      'pr-ref',
      'pr-submit',
    ]);
    expect(record.progress.releaseDocs?.publication).toMatchObject({
      status: 'created',
      path: 'update-log/release-previous-release.md',
    });
    expect(fake.packageWithJenkins).not.toHaveBeenCalled();
    expect(fake.prepareModifyLog).toHaveBeenCalledOnce();
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
  it('continues after finding the merged release PR and builds the target branch', async () => {
    const events: string[] = [];
    const { fake, pullRequest } = createFakeService(events);
    const mergedPullRequest = {
      ...pullRequest,
      state: 'closed' as const,
      mergedAt: '2026-09-29T10:00:00Z',
    };
    fake.findMergedPullRequest.mockImplementationOnce(async () => {
      events.push('merged-pr-check');
      return mergedPullRequest;
    });
    const docs = createFakeDocsService();
    const service = new ReleaseAutomationExecutionService(
      fake as unknown as ReleaseAutomationService,
      docs as never,
    );
    const record = createRecord('apply', ['git-tag', 'github-merge', 'jenkins']);
    record.pageConfig!.jenkinsBaseUrl = 'https://jenkins.example.com/job/package';
    record.pageConfig!.jenkinsToken = 'jenkins-token';
    record.pageConfig!.jenkinsTagMarker = 'image-name';
    const progress: ReleaseProgress[] = [];

    const error = await service.execute(record, async (next) => {
      progress.push(next);
    });

    expect(error).toBeNull();
    expect(fake.prepareModifyLog).toHaveBeenCalledOnce();
    expect(events).toEqual(['modify-log', 'merged-pr-check']);
    expect(fake.findMergedPullRequest).toHaveBeenCalledWith({
      repository: 'acme/project',
      sourceBranch: 'feature/release',
      targetBranch: 'custom/prod',
      releaseTag: 'release/版本 tag',
      config: expect.any(Object),
    });
    expect(docs.generate).not.toHaveBeenCalled();
    expect(fake.createOrReusePullRequest).not.toHaveBeenCalled();
    expect(fake.packageWithJenkins).toHaveBeenCalledWith(
      expect.objectContaining({ jenkinsBranch: 'custom/prod' }),
    );
    expect(progress.at(-1)).toMatchObject({ stage: 'completed', percent: 100 });
    expect(record.progress.taskStatuses).toMatchObject({
      'github-merge': 'succeeded',
      'release-docs': 'succeeded',
      jenkins: 'succeeded',
    });
  });

  it('keeps dry-run Git steps planned and never asks for apply mode', async () => {
    const events: string[] = [];
    const { fake, pullRequestCalls } = createFakeService(events);
    const docs = createFakeDocsService(undefined, events);
    fake.ensureTag.mockResolvedValue({ status: 'planned', sha: sourceSha });
    fake.createOrReusePullRequest.mockImplementation((options) => {
      events.push('pr-submit');
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
    expect(events).toEqual(['modify-log', 'release-docs', 'pr-ref', 'pr-ref', 'pr-submit']);
    expect(record.progress.releaseDocs?.publication).toMatchObject({ status: 'planned' });
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

  it('does not persist env SQL markdown to job progress when enabled', async () => {
    const { fake } = createFakeService();
    const docs = createFakeDocsService(
      "INSERT INTO sys_config VALUES ('SECRET_TOKEN', 'secret-value');",
    );
    const service = new ReleaseAutomationExecutionService(
      fake as unknown as ReleaseAutomationService,
      docs as never,
    );
    const record = createRecord('dry-run');
    record.pageConfig!.environmentToSql = true;
    const progress: ReleaseProgress[] = [];

    const error = await service.execute(record, async (next) => {
      progress.push(next);
    });

    expect(error).toBeNull();
    expect(record.progress.releaseDocs?.markdown).toBe('');
    const logText = progress
      .flatMap((item) => item.logs ?? [])
      .map((entry) => entry.message)
      .join('\n');
    expect(logText).not.toContain('secret-value');
  });

  it('blocks the target when PR submission fails after publishing docs', async () => {
    const events: string[] = [];
    const { fake } = createFakeService(events);
    const docs = createFakeDocsService(undefined, events);
    fake.createOrReusePullRequest.mockImplementationOnce(async () => {
      events.push('pr-submit');
      throw new Error('GitHub PR has conflicts');
    });
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
    expect(docs.generate).toHaveBeenCalledOnce();
    expect(events).toEqual([
      'modify-log',
      'merged-pr-check',
      'release-docs',
      'pr-ref',
      'pr-ref',
      'pr-submit',
    ]);
    expect(record.progress.releaseDocs?.publication).toMatchObject({
      status: 'created',
      path: 'update-log/release-previous-release.md',
    });
    expect(fake.createOrReusePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'feature/release', targetBranch: 'custom/prod' }),
    );
    expect(progress.at(-1)).toMatchObject({
      stage: 'preflight_blocked',
      taskStatuses: { 'git-tag': 'succeeded', 'github-merge': 'blocked' },
    });
    expect(progress.at(-1)?.stage).not.toBe('completed');
  });
});
