import { describe, expect, it, vi } from 'vitest';
import { ReleaseAutomationExecutionService } from '../modules/release-automation/release-automation-execution.service';
import type {
  ReleaseJobRecord,
  ReleaseProgress,
  ReleaseTaskKey,
} from '../modules/release-automation/release-automation.types';

function record(selectedTasks: ReleaseTaskKey[] = ['release-docs']): ReleaseJobRecord {
  const now = new Date(0).toISOString();
  const releaseUnit = {
    repository: 'acme/project',
    targetBranch: 'main',
    gitTag: 'release/1.0',
    version: 'release/1.0',
  };
  return {
    jobId: 'release-' + '1'.repeat(48),
    idempotencyKey: 'execution-test-key',
    payloadHash: 'a'.repeat(64),
    releaseUnit,
    mode: 'dry-run',
    pageConfig: {
      gitAddress: 'https://github.com/acme/project.git',
      branch: 'main',
      githubToken: '',
      jenkinsToken: '',
      jenkinsBaseUrl: '',
      feishuAppId: '',
      feishuAppSecret: '',
    },
    selectedTasks,
    progress: {
      stage: 'planned',
      sequence: 0,
      percent: 0,
      message: 'queued',
      updatedAt: now,
      releaseUnit,
    },
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('release automation task failure progress', () => {
  it('marks release-docs blocked instead of leaving it pending', async () => {
    const service = new ReleaseAutomationExecutionService({} as never);
    const progress: ReleaseProgress[] = [];
    const job = record();

    const error = await service.execute(job, async (next) => {
      progress.push(next);
    });

    expect(error).toMatchObject({ code: 'RELEASE_DOCS_INPUT_MISSING' });
    expect(progress.at(-1)).toMatchObject({
      stage: 'preflight_blocked',
      taskStatuses: { 'release-docs': 'blocked' },
    });
  });

  it('runs the selected modify-log task and reports planned status in dry-run', async () => {
    const releaseService = {
      prepareModifyLog: vi.fn().mockResolvedValue({
        sourceChecksum: 'a'.repeat(64),
        generation: 'generation',
        recordCount: 2,
        sql: '-- sql',
        artifact: null,
      }),
    };
    const docs = {
      generate: vi.fn().mockResolvedValue({
        status: 'degraded',
        repository: 'acme/project',
        previousTag: 'previous',
        currentTag: 'release/1.0',
        previousSha: 'a'.repeat(40),
        resolvedSha: 'b'.repeat(40),
        commitCount: 0,
        mergeCommitCount: 0,
        markdown: '# docs\n',
        markdownChecksum: 'c'.repeat(64),
        degraded: true,
        warnings: [],
      }),
    };
    const service = new ReleaseAutomationExecutionService(releaseService as never, docs as never);
    const job = record(['modify-log']);
    job.releaseDocs = {};
    const progress: ReleaseProgress[] = [];

    const error = await service.execute(job, async (next) => {
      progress.push(next);
    });

    expect(error).toBeNull();
    expect(releaseService.prepareModifyLog).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'dry-run', jobId: expect.stringContaining('release-') }),
    );
    expect(progress.at(-1)).toMatchObject({
      stage: 'completed',
      taskStatuses: { 'modify-log': 'planned' },
      modifyLog: { status: 'planned', recordCount: 2 },
    });
  });
});
