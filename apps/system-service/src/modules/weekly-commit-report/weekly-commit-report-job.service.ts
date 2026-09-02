import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProjectException } from '@nest-cloud/common';
import { WEEKLY_REPORT_MAX_ACTIVE_JOBS } from './weekly-report.constants';
import {
  WeeklyReportQueueService,
  type WeeklyReportQueueGateway,
} from './weekly-report-queue.service';
import type { WeeklyReportQueueSnapshot } from './weekly-report-queue.service';
import type {
  GenerateWeeklyReportInput,
  WeeklyReportJobCreateResult,
  WeeklyReportJobView,
  WeeklyReportJobStatus,
  WeeklyReportProgress,
} from './weekly-report.types';

@Injectable()
export class WeeklyCommitReportJobService {
  private admissionTail = Promise.resolve();

  constructor(
    @Inject(WeeklyReportQueueService)
    private readonly queueService: WeeklyReportQueueGateway,
  ) {}

  async create(input: GenerateWeeklyReportInput): Promise<WeeklyReportJobCreateResult> {
    const previous = this.admissionTail;
    let release!: () => void;
    this.admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const activeJobs = await this.queueService.getActiveCount();
      if (activeJobs >= WEEKLY_REPORT_MAX_ACTIVE_JOBS) {
        throw new ProjectException('当前周报任务过多，请稍后重试。', 429);
      }

      const jobId = `weekly-report-${randomUUID()}`;
      const progress = this.createProgress(
        'queued',
        0,
        input.configs?.length ?? 0,
        0,
        null,
        '任务已排队。',
      );
      await this.queueService.add(jobId, input, progress);
      return { jobId, status: 'queued', progress };
    } finally {
      release();
    }
  }

  async getStatus(jobId: string): Promise<WeeklyReportJobView> {
    const snapshot = await this.queueService.get(jobId);
    if (!snapshot) throw new ProjectException('周报任务不存在或已过期。', 404);

    const status = this.toJobStatus(snapshot.state);
    const progress = this.toProgress(snapshot);
    const error =
      status === 'failed'
        ? (snapshot.error ?? {
            code: 500,
            message: snapshot.failedReason || '周报任务执行失败。',
          })
        : null;
    return {
      jobId: snapshot.jobId,
      status,
      progress,
      result: snapshot.result,
      publication: snapshot.publication,
      error,
    };
  }

  private toJobStatus(state: WeeklyReportQueueSnapshot['state']): WeeklyReportJobStatus {
    if (state === 'active') return 'running';
    if (state === 'completed') return 'succeeded';
    if (state === 'failed') return 'failed';
    return 'queued';
  }

  private toProgress(snapshot: WeeklyReportQueueSnapshot): WeeklyReportProgress {
    if (this.isProgress(snapshot.progress)) return snapshot.progress;
    return this.createProgress(
      this.toJobStatus(snapshot.state) === 'running' ? 'collecting' : 'queued',
      0,
      snapshot.input.configs?.length ?? 0,
      0,
      null,
      '任务已排队。',
    );
  }

  private isProgress(value: WeeklyReportQueueSnapshot['progress']): value is WeeklyReportProgress {
    return !!value && typeof value === 'object' && typeof value.phase === 'string';
  }

  private createProgress(
    phase: WeeklyReportProgress['phase'],
    percent: number,
    totalProjects: number,
    completedProjects: number,
    currentProject: string | null,
    message: string,
    failedProjects = 0,
  ): WeeklyReportProgress {
    return {
      phase,
      percent,
      completedProjects,
      totalProjects,
      failedProjects,
      currentProject,
      message,
    };
  }
}
