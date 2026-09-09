import { Inject, Injectable } from '@nestjs/common';
import { ConflictException, ProjectException } from '@nest-cloud/common';
import { createHash } from 'node:crypto';
import {
  RELEASE_AUTOMATION_MAX_ACTIVE_JOBS,
  RELEASE_AUTOMATION_TAG_PATTERN,
} from './release-automation.constants';
import { payloadHash } from './release-automation.security';
import {
  ReleaseAutomationQueueService,
  type ReleaseQueueGateway,
} from './release-automation-queue.service';
import type {
  ReleaseJobCreateResult,
  ReleaseJobRecord,
  ReleaseJobStatusView,
  ReleasePlanInput,
  ReleaseProgress,
} from './release-automation.types';

@Injectable()
export class ReleaseAutomationJobService {
  private admissionTail = Promise.resolve();

  constructor(
    @Inject(ReleaseAutomationQueueService)
    private readonly queue: ReleaseQueueGateway,
  ) {}

  async create(input: {
    idempotencyKey: string;
    plan: ReleasePlanInput;
  }): Promise<ReleaseJobCreateResult> {
    const record = this.createExecutionRecord(input);
    const { jobId, payloadHash: hash } = record;
    const existing = await this.queue.get(jobId);
    if (existing) {
      if (existing.payloadHash !== hash)
        throw new ConflictException('相同幂等键的发布 payload 不一致。');
      return this.toCreateResult(existing, true, this.hashPlan(existing));
    }
    const previous = this.admissionTail;
    let release!: () => void;
    this.admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const raced = await this.queue.get(jobId);
      if (raced) {
        if (raced.payloadHash !== hash)
          throw new ConflictException('相同幂等键的发布 payload 不一致。');
        return this.toCreateResult(raced, true, this.hashPlan(raced));
      }
      if ((await this.queue.getActiveCount()) >= RELEASE_AUTOMATION_MAX_ACTIVE_JOBS)
        throw new ProjectException('当前发布任务过多，请稍后重试。', 429);
      await this.queue.add(record);
      return this.toCreateResult(record, false, this.hashPlan(record));
    } finally {
      release();
    }
  }

  createExecutionRecord(
    input: { idempotencyKey: string; plan: ReleasePlanInput },
    defaultMode: 'dry-run' | 'apply' = 'apply',
  ): ReleaseJobRecord {
    const key = input.idempotencyKey.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key))
      throw new ProjectException('Idempotency-Key 格式无效。', 400);
    const repository = this.selectRepository(
      input.plan.repository ?? input.plan.pageConfig?.gitAddress,
    );
    const gitTag = input.plan.gitTag;
    if (!RELEASE_AUTOMATION_TAG_PATTERN.test(gitTag))
      throw new ProjectException('gitTag 格式无效。', 400);
    if (!/^custom\/(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/.test(input.plan.targetBranch))
      throw new ProjectException('目标分支必须是 custom/* 且格式有效。', 400);
    const mode = input.plan.mode ?? defaultMode;
    const releaseUnit = {
      repository,
      targetBranch: input.plan.targetBranch,
      gitTag,
      ...(input.plan.candidateSha ? { candidateSha: input.plan.candidateSha.toLowerCase() } : {}),
      version: gitTag,
    } as const;
    const safePayload = {
      releaseUnit,
      mode,
      pageConfig: input.plan.pageConfig,
      selectedTasks: input.plan.selectedTasks,
    };
    const hash = payloadHash(safePayload);
    const jobId = deriveReleaseJobId(key);
    const now = new Date().toISOString();
    const progress: ReleaseProgress = {
      stage: 'planned',
      sequence: 0,
      percent: 0,
      message: '发布任务已排队。',
      updatedAt: now,
      releaseUnit,
    };
    return {
      jobId,
      idempotencyKey: key,
      payloadHash: hash,
      releaseUnit,
      mode,
      pageConfig: input.plan.pageConfig,
      selectedTasks: input.plan.selectedTasks,
      progress,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getStatus(jobId: string): Promise<ReleaseJobStatusView> {
    if (!/^release-[A-Za-z0-9-]{8,80}$/.test(jobId))
      throw new ProjectException('发布 Job ID 格式无效。', 400);
    const record = await this.queue.get(jobId);
    if (!record) throw new ProjectException('发布 Job 不存在或已过期。', 404);
    const { pageConfig: _pageConfig, ...publicRecord } = record;
    return { ...publicRecord, planHash: this.hashPlan(record) };
  }

  private selectRepository(input: string | undefined): string {
    if (!input) throw new ProjectException('必须指定 GitHub repository 或 gitAddress。', 400);
    const repository = normalizeRepository(input);
    if (!repository) throw new ProjectException('repository 格式无效。', 400);
    return repository;
  }

  private hashPlan(record: ReleaseJobRecord): string {
    return payloadHash({ releaseUnit: record.releaseUnit, mode: record.mode });
  }

  private toCreateResult(
    record: ReleaseJobRecord,
    idempotent: boolean,
    planHash: string,
  ): ReleaseJobCreateResult {
    return {
      jobId: record.jobId,
      status: record.progress.stage,
      progress: record.progress,
      idempotent,
      payloadHash: record.payloadHash,
      planHash,
    };
  }
}

function normalizeRepository(value: string): string {
  const input = value
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  const slug = /^https:\/\/github\.com\//i.test(input)
    ? input.replace(/^https:\/\/github\.com\//i, '')
    : input;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ? slug.toLowerCase() : '';
}

export function deriveReleaseJobId(idempotencyKey: string): string {
  return `release-${sha256(idempotencyKey.trim()).slice(0, 48)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
