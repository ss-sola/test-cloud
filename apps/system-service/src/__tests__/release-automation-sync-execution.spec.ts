import { describe, expect, it, vi } from 'vitest';
import { ReleaseAutomationExecutionService } from '../modules/release-automation/release-automation-execution.service';
import { ReleaseAutomationJobService } from '../modules/release-automation/release-automation-job.service';
import { ReleaseAutomationSyncService } from '../modules/release-automation/release-automation-sync.service';
import type { ReleaseQueueGateway } from '../modules/release-automation/release-automation-queue.service';
import type {
  ReleaseJobRecord,
  ReleasePlanInput,
  ReleaseProgress,
  ReleaseTaskKey,
} from '../modules/release-automation/release-automation.types';

class NoQueue implements ReleaseQueueGateway {
  add = vi.fn(async () => {
    throw new Error('sync endpoint must not enqueue');
  });
  get = vi.fn(async () => {
    throw new Error('sync endpoint must not read queue');
  });
  getActiveCount = vi.fn(async () => {
    throw new Error('sync endpoint must not inspect queue');
  });
}

function plan(mode?: 'dry-run' | 'apply'): ReleasePlanInput {
  return {
    repository: 'acme/project',
    targetBranch: 'custom/prod',
    gitTag: '1.9.0',
    mode,
    pageConfig: {
      gitAddress: 'https://github.com/acme/project.git',
      branch: 'custom/prod',
      githubToken: 'github-secret',
      jenkinsToken: 'jenkins-secret',
      jenkinsBaseUrl: '',
      feishuAppId: '',
      feishuAppSecret: '',
    },
    selectedTasks: ['git-tag', 'github-merge'] as ReleaseTaskKey[],
  };
}

function createSyncService(execute: ReleaseAutomationExecutionService['execute']) {
  const queue = new NoQueue();
  const jobService = new ReleaseAutomationJobService(queue);
  const execution = { execute } as unknown as ReleaseAutomationExecutionService;
  return { sync: new ReleaseAutomationSyncService(jobService, execution), queue };
}

describe('release automation synchronous test execution', () => {
  it('defaults to dry-run without touching the queue or exposing page secrets', async () => {
    const execute = vi.fn(
      async (record: ReleaseJobRecord, update: (progress: ReleaseProgress) => Promise<void>) => {
        await update({
          ...record.progress,
          stage: 'completed',
          sequence: 1,
          percent: 100,
          message: '同步 dry-run 完成。',
        });
        return null;
      },
    );
    const { sync, queue } = createSyncService(execute);

    const result = await sync.execute({
      idempotencyKey: 'release-sync-test-001',
      plan: plan(),
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'dry-run' }),
      expect.any(Function),
    );
    expect(result).toMatchObject({
      mode: 'dry-run',
      progress: { stage: 'completed', percent: 100 },
      error: null,
    });
    expect(result.events).toHaveLength(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.get).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('github-secret');
    expect(JSON.stringify(result)).not.toContain('jenkins-secret');
  });

  it('passes explicit apply mode to the shared execution service', async () => {
    const execute = vi.fn(async () => null);
    const { sync } = createSyncService(execute);

    const result = await sync.execute({
      idempotencyKey: 'release-sync-test-002',
      plan: plan('apply'),
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'apply' }),
      expect.any(Function),
    );
    expect(result.mode).toBe('apply');
    expect(result.error).toBeNull();
  });

  it('normalizes unexpected execution errors into a failed result', async () => {
    const execute = vi.fn(async () => {
      throw new Error('Authorization: github-secret');
    });
    const { sync } = createSyncService(execute);

    const result = await sync.execute({
      idempotencyKey: 'release-sync-test-003',
      plan: plan(),
    });

    expect(result).toMatchObject({
      progress: { stage: 'failed' },
      error: { code: 'EXECUTION_FAILED', retryable: false },
    });
    expect(result.error?.message).not.toContain('github-secret');
  });
});
