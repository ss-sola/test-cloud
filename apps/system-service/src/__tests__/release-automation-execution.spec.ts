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
const mergedSha = 'd'.repeat(40);

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
  const mergeCalls: Array<{
    sourceBranch: string;
    expectedTargetSha?: string;
    expectedSourceSha?: string;
    mode: string;
  }> = [];
  const fake = {
    ensureTag: vi.fn().mockResolvedValue({ status: 'created', sha: sourceSha }),
    getBranchRef: vi.fn(({ branch }: { branch: string }) => {
      const sha = branch === 'custom/prod' ? targetSha : sourceSha;
      return Promise.resolve({ ref: `refs/heads/${branch}`, sha });
    }),
    mergeBranch: vi.fn(
      (options: {
        sourceBranch: string;
        expectedTargetSha?: string;
        expectedSourceSha?: string;
        mode: string;
      }) => {
        mergeCalls.push(options);
        return Promise.resolve({
          status: 'merged' as 'merged' | 'planned',
          beforeSha: options.expectedTargetSha,
          afterSha: mergedSha,
          sourceSha: options.expectedSourceSha,
          targetBranch: 'custom/prod',
          sourceBranch: options.sourceBranch,
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
  return { fake, mergeCalls };
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
  it('executes tag then dev/master merges with the verified SHA chain', async () => {
    const { fake, mergeCalls } = createFakeService();
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
    expect(fake.ensureTag).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: 'dev/master',
        mode: 'apply',
      }),
    );
    expect(mergeCalls.map(({ sourceBranch }) => sourceBranch)).toEqual(['dev/master']);
    expect(mergeCalls[0]).toMatchObject({
      expectedTargetSha: targetSha,
      expectedSourceSha: sourceSha,
      mode: 'apply',
    });
    expect(progress.at(-1)).toMatchObject({ stage: 'completed', percent: 100 });
  });

  it('keeps dry-run Git steps planned and never asks for apply mode', async () => {
    const { fake, mergeCalls } = createFakeService();
    const docs = createFakeDocsService();
    fake.ensureTag.mockResolvedValue({ status: 'planned', sha: sourceSha });
    fake.mergeBranch.mockImplementation((options) => {
      mergeCalls.push(options);
      return Promise.resolve({
        status: 'planned' as const,
        beforeSha: targetSha,
        afterSha: targetSha,
        sourceSha: options.expectedSourceSha,
        targetBranch: 'custom/prod',
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
    expect(fake.ensureTag).toHaveBeenCalledWith(expect.objectContaining({ mode: 'dry-run' }));
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls.every(({ mode }) => mode === 'dry-run')).toBe(true);
    expect(progress.at(-1)).toMatchObject({ stage: 'completed', percent: 100 });
    expect(progress.at(-1)?.taskStatuses).toMatchObject({
      'git-tag': 'planned',
      'github-merge': 'planned',
    });
  });

  it('blocks the target when the single dev/master merge fails', async () => {
    const { fake } = createFakeService();
    const docs = createFakeDocsService();
    fake.mergeBranch.mockRejectedValueOnce(new Error('GitHub merge conflict'));
    const service = new ReleaseAutomationExecutionService(
      fake as unknown as ReleaseAutomationService,
      docs as never,
    );
    const record = createRecord('apply');
    const progress: ReleaseProgress[] = [];

    const error = await service.execute(record, async (next) => {
      progress.push(next);
    });

    expect(error).toMatchObject({ code: 'GITHUB_MERGE_FAILED', retryable: false });
    expect(fake.mergeBranch.mock.calls.map(([options]) => options.sourceBranch)).toEqual([
      'dev/master',
    ]);
    expect(progress.at(-1)).toMatchObject({
      stage: 'preflight_blocked',
      taskStatuses: { 'git-tag': 'succeeded', 'github-merge': 'blocked' },
    });
    expect(progress.at(-1)?.stage).not.toBe('completed');
  });
});
