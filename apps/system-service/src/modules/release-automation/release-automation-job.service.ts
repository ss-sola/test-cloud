import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConflictException, ProjectException } from '@nest-cloud/common';
import { createHash } from 'node:crypto';
import {
  RELEASE_AUTOMATION_MAX_ACTIVE_JOBS,
  RELEASE_AUTOMATION_VERSION,
} from './release-automation.constants';
import { readReleaseAutomationConfig } from './release-automation.config';
import type { ReleaseAutomationConfig } from './release-automation.config';
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

export const RELEASE_AUTOMATION_JOB_OPTIONS = Symbol('RELEASE_AUTOMATION_JOB_OPTIONS');

export interface ReleaseAutomationJobOptions {
  config?: ReleaseAutomationConfig;
}

@Injectable()
export class ReleaseAutomationJobService {
  private admissionTail = Promise.resolve();

  constructor(
    @Inject(ReleaseAutomationQueueService) private readonly queue: ReleaseQueueGateway,
    @Inject(RELEASE_AUTOMATION_JOB_OPTIONS)
    @Optional()
    private readonly options?: ReleaseAutomationJobOptions,
  ) {}

  async create(input: {
    idempotencyKey: string;
    plan: ReleasePlanInput;
  }): Promise<ReleaseJobCreateResult> {
    const key = input.idempotencyKey.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key))
      throw new ProjectException('Idempotency-Key 格式无效。', 400);
    const config = this.options?.config ?? readReleaseAutomationConfig();
    const repository = this.selectRepository(
      input.plan.repository,
      config.githubAllowedRepositories,
    );
    const version = input.plan.version ?? RELEASE_AUTOMATION_VERSION;
    if (version !== RELEASE_AUTOMATION_VERSION)
      throw new ProjectException(`版本必须固定为 ${RELEASE_AUTOMATION_VERSION}。`, 400);
    if (
      !/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,256}$/.test(input.plan.targetBranch) ||
      !input.plan.targetBranch.startsWith('custom/')
    )
      throw new ProjectException('目标分支必须是 custom/* 且格式有效。', 400);
    if (!/^[0-9a-f]{7,64}$/i.test(input.plan.candidateSha))
      throw new ProjectException('candidateSha 格式无效。', 400);
    if (input.plan.mode && input.plan.mode !== 'dry-run')
      throw new ProjectException('apply 必须经过独立授权接口，不能由创建请求体触发。', 403);
    const releaseUnit = {
      repository,
      targetBranch: input.plan.targetBranch,
      candidateSha: input.plan.candidateSha.toLowerCase(),
      version: RELEASE_AUTOMATION_VERSION,
    } as const;
    const safePayload = { releaseUnit, mode: 'dry-run' as const };
    const hash = payloadHash(safePayload);
    // 一个 Idempotency-Key 只能绑定一个 payload；不同 payload 必须走冲突分支，不能生成第二个 Job。
    const jobId = deriveReleaseJobId(key);
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
      const now = new Date().toISOString();
      const progress: ReleaseProgress = {
        stage: 'planned',
        sequence: 0,
        percent: 0,
        message: '发布任务已排队。',
        updatedAt: now,
        releaseUnit,
      };
      const record: ReleaseJobRecord = {
        jobId,
        idempotencyKey: key,
        payloadHash: hash,
        releaseUnit,
        mode: 'dry-run',
        progress,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.queue.add(record);
      return this.toCreateResult(record, false, this.hashPlan(record));
    } finally {
      release();
    }
  }

  async getStatus(jobId: string): Promise<ReleaseJobStatusView> {
    if (!/^release-[A-Za-z0-9-]{8,80}$/.test(jobId))
      throw new ProjectException('发布 Job ID 格式无效。', 400);
    const record = await this.queue.get(jobId);
    if (!record) throw new ProjectException('发布 Job 不存在或已过期。', 404);
    return { ...record, planHash: this.hashPlan(record) };
  }

  private selectRepository(input: string | undefined, allowlist: string[]): string {
    const normalizedAllowlist = allowlist.map(normalizeRepository).filter(Boolean);
    if (input) {
      const repository = normalizeRepository(input);
      if (!repository || !normalizedAllowlist.includes(repository))
        throw new ProjectException('repository 不在 GitHub allowlist。', 403);
      return repository;
    }
    if (normalizedAllowlist.length !== 1)
      throw new ProjectException('必须明确选择唯一的 GitHub allowlist repository。', 400);
    return normalizedAllowlist[0];
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
