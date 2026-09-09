import { describe, expect, it, vi } from 'vitest';
import { ProjectException } from '@nest-cloud/common';
import { WeeklyCommitReportJobService } from '../modules/weekly-commit-report/weekly-commit-report-job.service';
import type {
  WeeklyReportQueueGateway,
  WeeklyReportQueueSnapshot,
} from '../modules/weekly-commit-report/weekly-report-queue.service';
import type {
  GenerateWeeklyReportInput,
  WeeklyReportProgress,
  WeeklyReportResult,
} from '../modules/weekly-commit-report/weekly-report.types';

const input: GenerateWeeklyReportInput = {
  period: 'this-week',
  configs: [],
  runtime: { githubToken: 'token' },
};
const result: WeeklyReportResult = {
  period: 'this-week',
  weekStart: '2026-08-24',
  weekEnd: '2026-08-28',
  markdown: '# report\n',
  projects: [],
  projectErrors: [],
  commitCount: 0,
  degraded: false,
};
const progress: WeeklyReportProgress = {
  phase: 'completed',
  percent: 100,
  completedProjects: 0,
  totalProjects: 0,
  failedProjects: 0,
  currentProject: null,
  message: '周报已生成。',
};

function createSnapshot(
  overrides: Partial<WeeklyReportQueueSnapshot> = {},
): WeeklyReportQueueSnapshot {
  return {
    jobId: 'weekly-report-test',
    state: 'completed',
    progress,
    input,
    result,
    publication: null,
    error: null,
    failedReason: '',
    ...overrides,
  };
}

function createGateway(
  snapshot: WeeklyReportQueueSnapshot | null = createSnapshot(),
): WeeklyReportQueueGateway {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(snapshot),
    getActiveCount: vi.fn().mockResolvedValue(0),
  };
}

describe('WeeklyCommitReportJobService', () => {
  it('adds a queued job with the existing public id format', async () => {
    const queue = createGateway();
    const jobs = new WeeklyCommitReportJobService(queue);

    const created = await jobs.create(input);

    expect(created.jobId).toMatch(/^weekly-report-/);
    expect(created.status).toBe('queued');
    expect(created.progress.phase).toBe('queued');
    expect(queue.add).toHaveBeenCalledWith(created.jobId, input, created.progress);
  });

  it('maps a completed BullMQ job to the existing status view', async () => {
    const queue = createGateway(createSnapshot({ jobId: 'weekly-report-1' }));
    const jobs = new WeeklyCommitReportJobService(queue);

    await expect(jobs.getStatus('weekly-report-1')).resolves.toMatchObject({
      jobId: 'weekly-report-1',
      status: 'succeeded',
      progress,
      result,
      publication: null,
      error: null,
    });
  });

  it('preserves project failures in a succeeded result', async () => {
    const projectError = { repo: 'repo', repoLabel: 'repo', code: 404, message: 'not found' };
    const queue = createGateway(
      createSnapshot({
        result: { ...result, projectErrors: [projectError] },
        progress: { ...progress, totalProjects: 1, failedProjects: 1 },
      }),
    );
    const jobs = new WeeklyCommitReportJobService(queue);

    const status = await jobs.getStatus('weekly-report-test');

    expect(status.status).toBe('succeeded');
    expect(status.progress.failedProjects).toBe(1);
    expect(status.result?.projectErrors).toEqual([projectError]);
  });

  it('maps a failed BullMQ job to a normalized error', async () => {
    const queue = createGateway(
      createSnapshot({
        state: 'failed',
        progress: { ...progress, phase: 'failed', percent: 100, message: 'Token missing' },
        result: null,
        error: { code: 503, message: 'Token missing' },
        failedReason: 'Token missing',
      }),
    );
    const jobs = new WeeklyCommitReportJobService(queue);

    await expect(jobs.getStatus('weekly-report-test')).resolves.toMatchObject({
      status: 'failed',
      error: { code: 503, message: 'Token missing' },
    });
  });

  it('does not expose a missing BullMQ job', async () => {
    const jobs = new WeeklyCommitReportJobService(createGateway(null));

    await expect(jobs.getStatus('missing')).rejects.toMatchObject({
      message: '周报任务不存在或已过期。',
      status: 404,
    });
  });

  it('rejects a new job when the queue admission limit is reached', async () => {
    const queue = createGateway();
    queue.getActiveCount = vi.fn().mockResolvedValue(2);
    const jobs = new WeeklyCommitReportJobService(queue);

    await expect(jobs.create(input)).rejects.toBeInstanceOf(ProjectException);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
