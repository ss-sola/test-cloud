import { describe, expect, it, vi } from 'vitest';
import { ProjectException } from '@nest-cloud/common';
import { WeeklyCommitReportJobService } from '../modules/weekly-commit-report/weekly-commit-report-job.service';
import type {
  GenerateWeeklyReportInput,
  WeeklyReportResult,
} from '../modules/weekly-commit-report/weekly-report.types';

const input: GenerateWeeklyReportInput = { period: 'this-week', configs: [] };
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WeeklyCommitReportJobService', () => {
  it('returns a terminal result with backend progress', async () => {
    const progress = {
      phase: 'completed' as const,
      percent: 100,
      completedProjects: 1,
      totalProjects: 1,
      failedProjects: 0,
      currentProject: null,
      message: '周报已生成。',
    };
    const reportService = {
      generate: vi.fn().mockImplementation(async (_input, reporter) => {
        reporter(progress);
        return { ...result, projectErrors: [] };
      }),
    } as never;
    const jobs = new WeeklyCommitReportJobService(reportService);

    const created = jobs.create(input);
    await tick();
    const status = jobs.getStatus(created.jobId);

    expect(created.jobId).toMatch(/^weekly-report-/);
    expect(status.status).toBe('succeeded');
    expect(status.progress.percent).toBe(100);
    expect(status.result).toEqual(result);
    expect(status.error).toBeNull();
  });

  it('keeps project failures in a succeeded result', async () => {
    const projectError = { repo: 'repo', repoLabel: 'repo', code: 404, message: 'not found' };
    const reportService = {
      generate: vi.fn().mockResolvedValue({ ...result, projectErrors: [projectError] }),
    } as never;
    const jobs = new WeeklyCommitReportJobService(reportService);

    const created = jobs.create(input);
    await tick();
    const status = jobs.getStatus(created.jobId);

    expect(status.status).toBe('succeeded');
    expect(status.progress.failedProjects).toBe(1);
    expect(status.result?.projectErrors).toEqual([projectError]);
  });

  it('marks task-level failures as failed', async () => {
    const reportService = {
      generate: vi.fn().mockRejectedValue(new ProjectException('Token missing', 503)),
    } as never;
    const jobs = new WeeklyCommitReportJobService(reportService);

    const created = jobs.create(input);
    await tick();
    const status = jobs.getStatus(created.jobId);

    expect(status.status).toBe('failed');
    expect(status.progress.phase).toBe('failed');
    expect(status.error).toEqual({ code: 503, message: 'Token missing' });
  });

  it('keeps a generated report succeeded when Feishu publication fails', async () => {
    const reportService = {
      generate: vi.fn().mockResolvedValue(result),
    } as never;
    const publicationService = {
      publishIfEnabled: vi.fn().mockRejectedValue(new Error('权限不足')),
    } as never;
    const jobs = new WeeklyCommitReportJobService(reportService, publicationService);

    const created = jobs.create({ ...input, publish: { enabled: true, person: '张三' } });
    await tick();
    const status = jobs.getStatus(created.jobId);

    expect(status.status).toBe('succeeded');
    expect(status.result).toEqual(result);
    expect(status.publication).toEqual({
      status: 'failed',
      retryable: false,
      message: '权限不足',
    });
    expect(status.progress.message).toContain('发布失败');
  });

  it('records a successful Feishu publication without changing report result', async () => {
    const reportService = {
      generate: vi.fn().mockResolvedValue(result),
    } as never;
    const publicationService = {
      publishIfEnabled: vi.fn().mockResolvedValue({
        status: 'skipped',
        range: 'sheet!C1:G1',
        row: 1,
      }),
    } as never;
    const jobs = new WeeklyCommitReportJobService(reportService, publicationService);

    const created = jobs.create({ ...input, publish: { enabled: true, person: '张三' } });
    await tick();
    const status = jobs.getStatus(created.jobId);

    expect(status.status).toBe('succeeded');
    expect(status.publication).toMatchObject({ status: 'skipped', range: 'sheet!C1:G1' });
  });

  it('limits active tasks', () => {
    let resolveFirst!: (value: WeeklyReportResult) => void;
    const pending = new Promise<WeeklyReportResult>((resolve) => {
      resolveFirst = resolve;
    });
    const reportService = { generate: vi.fn().mockReturnValue(pending) } as never;
    const jobs = new WeeklyCommitReportJobService(reportService);

    jobs.create(input);
    jobs.create(input);
    expect(() => jobs.create(input)).toThrow(/任务过多/);
    resolveFirst(result);
  });
});
