import { describe, expect, it, vi } from 'vitest';
import { ProjectException } from '@nest-cloud/common';
import { WeeklyReportQueueService } from '../modules/weekly-commit-report/weekly-report-queue.service';
import type {
  GenerateWeeklyReportInput,
  WeeklyReportProgress,
  WeeklyReportResult,
} from '../modules/weekly-commit-report/weekly-report.types';

const input: GenerateWeeklyReportInput = {
  period: 'this-week',
  configs: [],
};
const initialProgress: WeeklyReportProgress = {
  phase: 'queued',
  percent: 0,
  completedProjects: 0,
  totalProjects: 0,
  failedProjects: 0,
  currentProject: null,
  message: '任务已排队。',
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

function createJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'weekly-report-test',
    data: { input, initialProgress },
    progress: 0,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    updateData: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function processJob(service: WeeklyReportQueueService, job: unknown) {
  return (service as unknown as { process(value: unknown): Promise<unknown> }).process(job);
}

describe('WeeklyReportQueueService', () => {
  it('runs report generation and cleans sensitive settings from job data', async () => {
    const reportService = {
      generate: vi.fn().mockImplementation(async (_input, reportProgress) => {
        reportProgress({ ...initialProgress, phase: 'collecting', percent: 25 });
        return result;
      }),
    };
    const publicationService = {
      publishIfEnabled: vi.fn().mockResolvedValue(null),
    };
    const service = new WeeklyReportQueueService(
      reportService as never,
      publicationService as never,
    );
    const job = createJob();

    await expect(processJob(service, job)).resolves.toEqual({ result, publication: null });
    expect(reportService.generate).toHaveBeenCalledWith(input, expect.any(Function));
    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'collecting', percent: 25 }),
    );
    expect(job.updateProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'completed', percent: 100 }),
    );
    expect(job.updateData).toHaveBeenCalledWith({
      input,
      initialProgress,
    });
  });

  it('keeps publication failures inside a successful report job', async () => {
    const reportService = { generate: vi.fn().mockResolvedValue(result) };
    const publicationService = {
      publishIfEnabled: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('权限不足'), { retryable: false })),
    };
    const service = new WeeklyReportQueueService(
      reportService as never,
      publicationService as never,
    );
    const job = createJob({
      data: {
        input: { ...input, publish: { enabled: true, person: '张三' } },
        initialProgress,
      },
    });

    await expect(processJob(service, job)).resolves.toMatchObject({
      result,
      publication: { status: 'failed', message: '权限不足', retryable: false },
    });
    expect(job.updateProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'completed', message: '周报已生成，但飞书发布失败。' }),
    );
  });

  it('preserves the latest progress when report generation fails', async () => {
    const latestProgress = {
      ...initialProgress,
      phase: 'summarizing' as const,
      percent: 48,
      completedProjects: 1,
      totalProjects: 3,
      currentProject: 'repo',
    };
    const reportService = {
      generate: vi.fn().mockImplementation(async (_input, reportProgress) => {
        reportProgress(latestProgress);
        throw new ProjectException('Token missing', 503);
      }),
    };
    const service = new WeeklyReportQueueService(reportService as never);
    const job = createJob();

    await expect(processJob(service, job)).rejects.toThrow('Token missing');
    expect(job.updateProgress).toHaveBeenLastCalledWith({
      ...latestProgress,
      phase: 'failed',
      currentProject: null,
      message: 'Token missing',
    });
    expect(job.updateData).toHaveBeenCalledWith({
      input,
      initialProgress,
      error: { code: 503, message: 'Token missing' },
    });
  });

  it('does not publish a queued job whose in-memory publish settings are gone', async () => {
    const reportService = { generate: vi.fn().mockResolvedValue(result) };
    const publicationService = { publishIfEnabled: vi.fn() };
    const service = new WeeklyReportQueueService(
      reportService as never,
      publicationService as never,
    );
    const job = createJob({
      data: {
        input: { ...input, publish: { enabled: true, person: '张三' } },
        initialProgress,
        requiresPublishSettings: true,
      },
    });

    await expect(processJob(service, job)).resolves.toMatchObject({
      publication: {
        status: 'failed',
        message: '周报任务的飞书发布配置已不可用，请重新提交任务。',
      },
    });
    expect(publicationService.publishIfEnabled).not.toHaveBeenCalled();
  });
});
