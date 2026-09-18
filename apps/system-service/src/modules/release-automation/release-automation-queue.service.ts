import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigKeys, getConfig, ProjectException } from '@nest-cloud/common';
import { Job, Queue, Worker, type ConnectionOptions } from 'bullmq';
import { redactSensitiveText } from './release-automation.security';
import {
  RELEASE_AUTOMATION_JOB_TTL_MS,
  RELEASE_AUTOMATION_QUEUE_JOB_NAME,
  RELEASE_AUTOMATION_QUEUE_NAME,
  RELEASE_AUTOMATION_QUEUE_PREFIX,
} from './release-automation.constants';
import { ReleaseAutomationExecutionService } from './release-automation-execution.service';
import type { ReleaseJobRecord, ReleaseProgress } from './release-automation.types';

export interface ReleaseQueueJobData {
  record: ReleaseJobRecord;
}

export interface ReleaseQueueGateway {
  add(record: ReleaseJobRecord): Promise<void>;
  get(jobId: string): Promise<ReleaseJobRecord | null>;
  getActiveCount(): Promise<number>;
}

@Injectable()
export class ReleaseAutomationQueueService implements ReleaseQueueGateway, OnModuleDestroy {
  private readonly logger = new Logger(ReleaseAutomationQueueService.name);
  private queue?: Queue<ReleaseQueueJobData>;
  private worker?: Worker<ReleaseQueueJobData>;

  constructor(private readonly execution: ReleaseAutomationExecutionService) {}

  async add(record: ReleaseJobRecord): Promise<void> {
    const redisUrl = getConfig<string>(ConfigKeys.SessionRedisUrl, '', false).trim();
    if (!redisUrl) {
      throw new ProjectException('未配置 SessionRedisUrl，拒绝回退到进程内存。', 503);
    }
    const queue = this.ensureQueue(redisUrl, RELEASE_AUTOMATION_QUEUE_PREFIX);
    const existing = await queue.getJob(record.jobId);
    if (existing) throw new ProjectException('发布 Job 已存在。', 409);
    await queue.add(
      RELEASE_AUTOMATION_QUEUE_JOB_NAME,
      { record: this.safeRecord(record) },
      {
        jobId: record.jobId,
        attempts: 1,
        removeOnComplete: { age: RELEASE_AUTOMATION_JOB_TTL_MS / 1000 },
        removeOnFail: { age: RELEASE_AUTOMATION_JOB_TTL_MS / 1000 },
      },
    );
  }

  async get(jobId: string): Promise<ReleaseJobRecord | null> {
    const redisUrl = getConfig<string>(ConfigKeys.SessionRedisUrl, '', false).trim();
    if (!redisUrl) {
      throw new ProjectException('未配置 SessionRedisUrl。', 503);
    }
    const queue = this.ensureQueue(redisUrl, RELEASE_AUTOMATION_QUEUE_PREFIX);
    const job = await queue.getJob(jobId);
    if (!job) return null;
    const data = job.data.record;
    const progress = this.isProgress(job.progress) ? job.progress : data.progress;
    return {
      ...data,
      progress,
      error: data.error,
      updatedAt: data.updatedAt,
    };
  }

  async getActiveCount(): Promise<number> {
    const redisUrl = getConfig<string>(ConfigKeys.SessionRedisUrl, '', false).trim();
    if (!redisUrl) {
      throw new ProjectException('未配置 SessionRedisUrl。', 503);
    }
    const queue = this.ensureQueue(redisUrl, RELEASE_AUTOMATION_QUEUE_PREFIX);
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    return Object.values(counts).reduce((total, count) => total + count, 0);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.worker?.close(), this.queue?.close()]);
    this.worker = undefined;
    this.queue = undefined;
  }

  private ensureQueue(redisUrl: string, prefix: string): Queue<ReleaseQueueJobData> {
    if (this.queue && this.worker) return this.queue;
    const connection: ConnectionOptions = { url: redisUrl, maxRetriesPerRequest: null };
    this.queue = new Queue<ReleaseQueueJobData>(RELEASE_AUTOMATION_QUEUE_NAME, {
      connection,
      prefix: prefix || RELEASE_AUTOMATION_QUEUE_PREFIX,
    });
    this.worker = new Worker<ReleaseQueueJobData>(
      RELEASE_AUTOMATION_QUEUE_NAME,
      (job) => this.processJob(job),
      {
        connection,
        prefix: prefix || RELEASE_AUTOMATION_QUEUE_PREFIX,
        concurrency: 1,
      },
    );
    this.worker.on('error', (error) =>
      this.logger.error(`发布自动化 Worker 异常：${error.message}`, error.stack),
    );
    this.queue.on('error', (error) =>
      this.logger.error(`发布自动化 Queue 异常：${error.message}`, error.stack),
    );
    return this.queue;
  }

  private async processJob(job: Job<ReleaseQueueJobData>): Promise<void> {
    const record = job.data.record;
    try {
      record.error = await this.execution.execute(record, async (progress) => {
        const safeProgress = this.safeProgress(progress);
        await job.updateProgress(safeProgress);
        await job.updateData({ record: this.safeRecord(record) });
      });
      await job.updateData({ record: this.safeRecord(record, false) });
    } catch (error) {
      record.error = {
        code: 'EXECUTION_FAILED',
        message: redactSensitiveText(
          error instanceof Error ? error.message : '发布 Job 执行失败。',
        ),
        retryable: false,
      };
      record.progress = {
        ...record.progress,
        stage: 'failed',
        sequence: record.progress.sequence + 1,
        message: '发布 Job 执行失败。',
        updatedAt: new Date().toISOString(),
      };
      await job.updateProgress(this.safeProgress(record.progress));
      await job.updateData({ record: this.safeRecord(record, false) });
      throw error;
    }
  }

  private safeProgress(progress: ReleaseProgress): ReleaseProgress {
    return {
      ...progress,
      message: redactSensitiveText(progress.message),
      logs: progress.logs?.map((entry) => ({
        ...entry,
        message: redactSensitiveText(entry.message),
      })),
    };
  }

  private safeRecord(record: ReleaseJobRecord, includeRuntime = true): ReleaseJobRecord {
    const { pageConfig, runtime, ...publicRecord } = record;
    return {
      ...publicRecord,
      ...(includeRuntime && pageConfig ? { pageConfig } : {}),
      ...(includeRuntime && runtime ? { runtime } : {}),
      logs: record.logs?.map((entry) => ({
        ...entry,
        message: redactSensitiveText(entry.message),
      })),
      progress: {
        ...record.progress,
        message: redactSensitiveText(record.progress.message),
        releaseUnit: { ...record.progress.releaseUnit },
        logs: record.logs?.map((entry) => ({
          ...entry,
          message: redactSensitiveText(entry.message),
        })),
      },
      error: record.error
        ? {
            ...record.error,
            message: redactSensitiveText(record.error.message),
          }
        : null,
    };
  }

  private isProgress(value: unknown): value is ReleaseProgress {
    return (
      !!value &&
      typeof value === 'object' &&
      typeof (value as ReleaseProgress).stage === 'string' &&
      Number.isInteger((value as ReleaseProgress).sequence)
    );
  }
}
