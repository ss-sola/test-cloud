import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigKeys, getConfig, ProjectException } from '@nest-cloud/common';
import { Job, Queue, Worker, type ConnectionOptions } from 'bullmq';
import {
  WEEKLY_REPORT_JOB_TTL_MS,
  WEEKLY_REPORT_QUEUE_JOB_NAME,
  WEEKLY_REPORT_QUEUE_NAME,
  WEEKLY_REPORT_QUEUE_PREFIX,
  WEEKLY_REPORT_WORKER_CONCURRENCY,
} from './weekly-report.constants';
import { WeeklyCommitReportService } from './weekly-commit-report.service';
import { WeeklyReportPublicationService } from './weekly-report-publication.service';
import type {
  GenerateWeeklyReportInput,
  WeeklyReportJobError,
  WeeklyReportProgress,
  WeeklyReportPublicationResult,
  WeeklyReportResult,
} from './weekly-report.types';

export interface WeeklyReportQueueJobData {
  input: GenerateWeeklyReportInput;
  initialProgress: WeeklyReportProgress;
  requiresPublishSettings?: boolean;
  error?: WeeklyReportJobError;
}

export interface WeeklyReportQueueResult {
  result: WeeklyReportResult;
  publication: WeeklyReportPublicationResult | null;
}

export type WeeklyReportQueueState =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'unknown';

export interface WeeklyReportQueueSnapshot {
  jobId: string;
  state: WeeklyReportQueueState;
  progress: WeeklyReportProgress | number;
  input: GenerateWeeklyReportInput;
  result: WeeklyReportResult | null;
  publication: WeeklyReportPublicationResult | null;
  error: WeeklyReportJobError | null;
  failedReason: string;
}

export interface WeeklyReportQueueGateway {
  add(
    jobId: string,
    input: GenerateWeeklyReportInput,
    progress: WeeklyReportProgress,
  ): Promise<void>;
  get(jobId: string): Promise<WeeklyReportQueueSnapshot | null>;
  getActiveCount(): Promise<number>;
}

@Injectable()
export class WeeklyReportQueueService implements WeeklyReportQueueGateway, OnModuleDestroy {
  private readonly logger = new Logger(WeeklyReportQueueService.name);
  private readonly executionInputs = new Map<string, GenerateWeeklyReportInput>();
  private queue?: Queue<WeeklyReportQueueJobData, WeeklyReportQueueResult>;
  private worker?: Worker<WeeklyReportQueueJobData, WeeklyReportQueueResult>;

  constructor(
    private readonly reportService: WeeklyCommitReportService,
    @Optional() private readonly publicationService?: WeeklyReportPublicationService,
  ) {}

  afterApplicationBootstrap(): void {
    this.ensureInitialized();
  }

  async add(
    jobId: string,
    input: GenerateWeeklyReportInput,
    progress: WeeklyReportProgress,
  ): Promise<void> {
    const queue = this.ensureInitialized();
    this.executionInputs.set(jobId, input);
    try {
      await queue.add(
        WEEKLY_REPORT_QUEUE_JOB_NAME,
        {
          input: this.removeSensitiveInput(input),
          initialProgress: progress,
          requiresPublishSettings: !!input.publish?.settings,
        },
        {
          jobId,
          attempts: 1,
          removeOnComplete: { age: WEEKLY_REPORT_JOB_TTL_MS / 1000 },
          removeOnFail: { age: WEEKLY_REPORT_JOB_TTL_MS / 1000 },
        },
      );
    } catch (error) {
      this.executionInputs.delete(jobId);
      throw error;
    }
  }

  async get(jobId: string): Promise<WeeklyReportQueueSnapshot | null> {
    const queue = this.ensureInitialized();
    const job = await queue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    if (
      (state === 'completed' || state === 'failed') &&
      job.finishedOn &&
      Date.now() - job.finishedOn >= WEEKLY_REPORT_JOB_TTL_MS
    ) {
      await job.remove();
      return null;
    }
    const returnValue = job.returnvalue;
    const data = job.data;
    return {
      jobId: job.id ?? jobId,
      state: this.toQueueState(state),
      progress: job.progress as WeeklyReportProgress | number,
      input: data.input,
      result: returnValue?.result ?? null,
      publication: returnValue?.publication ?? null,
      error: data.error ?? null,
      failedReason: job.failedReason ?? '',
    };
  }

  async getActiveCount(): Promise<number> {
    const queue = this.ensureInitialized();
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    return Object.values(counts).reduce((total, count) => total + count, 0);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.worker?.close(), this.queue?.close()]);
    this.worker = undefined;
    this.queue = undefined;
    this.executionInputs.clear();
  }

  private ensureInitialized(): Queue<WeeklyReportQueueJobData, WeeklyReportQueueResult> {
    if (this.queue && this.worker) return this.queue;

    const redisUrl = getConfig<string>(ConfigKeys.SessionRedisUrl, '', false).trim();
    if (!redisUrl) {
      throw new ProjectException('未配置 SessionRedisUrl，无法启动周报 BullMQ 队列。', 503);
    }

    const connection: ConnectionOptions = { url: redisUrl, maxRetriesPerRequest: null };
    const queue = new Queue<WeeklyReportQueueJobData, WeeklyReportQueueResult>(
      WEEKLY_REPORT_QUEUE_NAME,
      {
        connection,
        prefix: WEEKLY_REPORT_QUEUE_PREFIX,
      },
    );
    const worker = new Worker<WeeklyReportQueueJobData, WeeklyReportQueueResult>(
      WEEKLY_REPORT_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection,
        prefix: WEEKLY_REPORT_QUEUE_PREFIX,
        concurrency: WEEKLY_REPORT_WORKER_CONCURRENCY,
      },
    );
    worker.on('error', (error) => {
      this.logger.error(`周报 BullMQ Worker 异常：${error.message}`, error.stack);
    });
    queue.on('error', (error) => {
      this.logger.error(`周报 BullMQ Queue 异常：${error.message}`, error.stack);
    });
    this.queue = queue;
    this.worker = worker;
    return queue;
  }

  private async process(
    job: Job<WeeklyReportQueueJobData, WeeklyReportQueueResult>,
  ): Promise<WeeklyReportQueueResult> {
    const jobId = job.id ?? '';
    const input = this.executionInputs.get(jobId) ?? job.data.input;
    const hasMissingPublishSettings =
      !this.executionInputs.has(jobId) && !!job.data.requiresPublishSettings;
    let latestProgress = job.data.initialProgress;
    let progressUpdate = Promise.resolve();
    let jobError: WeeklyReportJobError | null = null;

    if (!this.isProgress(job.progress)) {
      try {
        await job.updateProgress(latestProgress);
      } catch (error) {
        this.logger.warn(
          `周报 BullMQ 初始进度写入失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    try {
      const result = await this.reportService.generate(input, (progress) => {
        latestProgress = progress;
        progressUpdate = progressUpdate
          .then(() => job.updateProgress(progress))
          .catch((error: unknown) => {
            this.logger.warn(
              `周报 BullMQ 进度写入失败：${error instanceof Error ? error.message : String(error)}`,
            );
          });
      });
      await progressUpdate;
      let publication: WeeklyReportPublicationResult | null = null;

      if (hasMissingPublishSettings) {
        publication = {
          status: 'failed',
          retryable: false,
          message: '周报任务的飞书发布配置已不可用，请重新提交任务。',
        };
      } else if (this.publicationService && input.publish?.enabled !== false) {
        const publishingProgress: WeeklyReportProgress = {
          phase: 'publishing',
          percent: 99,
          completedProjects: result.projects.length + result.projectErrors.length,
          totalProjects: result.projects.length + result.projectErrors.length,
          failedProjects: result.projectErrors.length,
          currentProject: null,
          message: '正在写入飞书周报。',
        };
        latestProgress = publishingProgress;
        await job.updateProgress(publishingProgress);
        try {
          publication = await this.publicationService.publishIfEnabled(result, input.publish);
        } catch (error) {
          publication = this.toPublicationError(error);
        }
      } else if (input.publish?.enabled) {
        publication = {
          status: 'failed',
          retryable: false,
          message: '飞书周报发布服务未注册。',
        };
      }

      const completedProgress: WeeklyReportProgress = {
        phase: 'completed',
        percent: 100,
        completedProjects: result.projects.length,
        totalProjects: result.projects.length + result.projectErrors.length,
        failedProjects: result.projectErrors.length,
        currentProject: null,
        message:
          publication?.status === 'failed'
            ? '周报已生成，但飞书发布失败。'
            : result.projectErrors.length > 0
              ? '周报已生成，部分项目读取失败。'
              : '周报已生成。',
      };
      latestProgress = completedProgress;
      await job.updateProgress(completedProgress);
      return { result, publication };
    } catch (error) {
      await progressUpdate;
      jobError = this.toJobError(error);
      const failedProgress: WeeklyReportProgress = {
        ...latestProgress,
        phase: 'failed',
        currentProject: null,
        message: jobError.message,
      };
      latestProgress = failedProgress;
      await job.updateProgress(failedProgress);
      throw error;
    } finally {
      this.executionInputs.delete(jobId);
      const safeData: WeeklyReportQueueJobData = {
        input: this.removeSensitiveInput(input),
        initialProgress: job.data.initialProgress,
      };
      if (jobError) safeData.error = jobError;
      try {
        await job.updateData(safeData);
      } catch (error) {
        this.logger.warn(
          `周报 BullMQ Job 敏感数据清理失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private removeSensitiveInput(input: GenerateWeeklyReportInput): GenerateWeeklyReportInput {
    return {
      period: input.period,
      configs: input.configs,
      publish: input.publish
        ? { enabled: input.publish.enabled, person: input.publish.person }
        : undefined,
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

  private isProgress(value: unknown): value is WeeklyReportProgress {
    return (
      !!value &&
      typeof value === 'object' &&
      typeof (value as WeeklyReportProgress).phase === 'string'
    );
  }

  private toQueueState(state: string): WeeklyReportQueueState {
    if (
      state === 'waiting' ||
      state === 'active' ||
      state === 'completed' ||
      state === 'failed' ||
      state === 'delayed'
    )
      return state;
    return 'unknown';
  }
}
