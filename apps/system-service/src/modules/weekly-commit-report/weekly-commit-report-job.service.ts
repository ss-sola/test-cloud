import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProjectException } from '@nest-cloud/common';
import { WEEKLY_REPORT_JOB_TTL_MS, WEEKLY_REPORT_MAX_ACTIVE_JOBS } from './weekly-report.constants';
import { WeeklyCommitReportService } from './weekly-commit-report.service';
import { WeeklyReportPublicationService } from './weekly-report-publication.service';
import type {
  GenerateWeeklyReportInput,
  WeeklyReportJobCreateResult,
  WeeklyReportJobError,
  WeeklyReportJobView,
  WeeklyReportJobStatus,
  WeeklyReportProgress,
  WeeklyReportPublicationResult,
} from './weekly-report.types';

interface WeeklyReportJobRecord {
  jobId: string;
  input: GenerateWeeklyReportInput;
  status: WeeklyReportJobStatus;
  progress: WeeklyReportProgress;
  result: WeeklyReportJobView['result'];
  publication: WeeklyReportJobView['publication'];
  error: WeeklyReportJobError | null;
  createdAt: number;
  updatedAt: number;
}

@Injectable()
export class WeeklyCommitReportJobService {
  private readonly jobs = new Map<string, WeeklyReportJobRecord>();

  constructor(
    private readonly reportService: WeeklyCommitReportService,
    @Optional() private readonly publicationService?: WeeklyReportPublicationService,
  ) {}

  create(input: GenerateWeeklyReportInput): WeeklyReportJobCreateResult {
    this.cleanupExpiredJobs();
    const activeJobs = [...this.jobs.values()].filter(
      (job) => job.status === 'queued' || job.status === 'running',
    );
    if (activeJobs.length >= WEEKLY_REPORT_MAX_ACTIVE_JOBS) {
      throw new ProjectException('当前周报任务过多，请稍后重试。', 429);
    }

    const now = Date.now();
    const jobId = `weekly-report-${randomUUID()}`;
    const progress = this.createProgress(
      'queued',
      0,
      input.configs?.length ?? 0,
      0,
      null,
      '任务已排队。',
    );
    const job: WeeklyReportJobRecord = {
      jobId,
      input,
      status: 'queued',
      progress,
      result: null,
      publication: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, job);
    this.trimJobMap();
    void this.run(job);
    return { jobId, status: job.status, progress: job.progress };
  }

  getStatus(jobId: string): WeeklyReportJobView {
    this.cleanupExpiredJobs();
    const job = this.jobs.get(jobId);
    if (!job) throw new ProjectException('周报任务不存在或已过期。', 404);
    return {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      result: job.result,
      publication: job.publication,
      error: job.error,
    };
  }

  private async run(job: WeeklyReportJobRecord): Promise<void> {
    job.status = 'running';
    job.updatedAt = Date.now();
    try {
      const result = await this.reportService.generate(job.input, (progress) => {
        job.progress = progress;
        job.updatedAt = Date.now();
      });
      job.result = result;

      if (this.publicationService) {
        job.progress = this.createProgress(
          'publishing',
          99,
          result.projects.length + result.projectErrors.length,
          result.projects.length + result.projectErrors.length,
          null,
          '正在写入飞书周报。',
          result.projectErrors.length,
        );
        try {
          job.publication = await this.publicationService.publishIfEnabled(
            result,
            job.input.publish,
          );
        } catch (error) {
          job.publication = this.toPublicationError(error);
        }
      } else if (job.input.publish?.enabled) {
        job.publication = {
          status: 'failed',
          retryable: false,
          message: '飞书周报发布服务未注册。',
        };
      }

      job.status = 'succeeded';
      job.progress = this.createProgress(
        'completed',
        100,
        result.projects.length + result.projectErrors.length,
        result.projects.length,
        null,
        job.publication?.status === 'failed'
          ? '周报已生成，但飞书发布失败。'
          : result.projectErrors.length > 0
            ? '周报已生成，部分项目读取失败。'
            : '周报已生成。',
        result.projectErrors.length,
      );
      job.error = null;
    } catch (error) {
      job.status = 'failed';
      job.error = this.toJobError(error);
      job.progress = {
        ...job.progress,
        phase: 'failed',
        currentProject: null,
        message: job.error.message,
      };
    } finally {
      job.updatedAt = Date.now();
    }
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

  private toPublicationError(error: unknown): WeeklyReportPublicationResult {
    const retryable =
      !!error &&
      typeof error === 'object' &&
      'retryable' in error &&
      (error as { retryable?: unknown }).retryable === true;
    return {
      status: 'failed',
      retryable,
      message: error instanceof Error ? error.message : '飞书周报发布失败。',
    };
  }

  private toJobError(error: unknown): WeeklyReportJobError {
    if (error instanceof ProjectException) {
      return { code: error.getStatus(), message: error.message };
    }
    return { code: 500, message: '周报任务执行失败。' };
  }

  private cleanupExpiredJobs(): void {
    const expiry = Date.now() - WEEKLY_REPORT_JOB_TTL_MS;
    for (const [jobId, job] of this.jobs) {
      if (job.status !== 'queued' && job.status !== 'running' && job.updatedAt < expiry) {
        this.jobs.delete(jobId);
      }
    }
  }

  private trimJobMap(): void {
    if (this.jobs.size <= 100) return;
    const oldest = [...this.jobs.values()]
      .filter((job) => job.status !== 'queued' && job.status !== 'running')
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];
    if (oldest) this.jobs.delete(oldest.jobId);
  }
}
