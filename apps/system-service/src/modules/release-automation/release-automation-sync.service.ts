import { Injectable } from '@nestjs/common';
import { redactSensitiveText } from './release-automation.security';
import { ReleaseAutomationExecutionService } from './release-automation-execution.service';
import { ReleaseAutomationJobService } from './release-automation-job.service';
import type {
  ReleaseJobError,
  ReleaseJobRecord,
  ReleasePlanInput,
  ReleaseProgress,
} from './release-automation.types';

export interface ReleaseAutomationSyncResult {
  jobId: string;
  mode: ReleaseJobRecord['mode'];
  releaseUnit: ReleaseJobRecord['releaseUnit'];
  progress: ReleaseProgress;
  events: ReleaseProgress[];
  error: ReleaseJobError | null;
}

@Injectable()
export class ReleaseAutomationSyncService {
  constructor(
    private readonly jobService: ReleaseAutomationJobService,
    private readonly execution: ReleaseAutomationExecutionService,
  ) {}

  async execute(input: {
    idempotencyKey: string;
    plan: ReleasePlanInput;
  }): Promise<ReleaseAutomationSyncResult> {
    const record = this.jobService.createExecutionRecord(input, 'dry-run');
    const events: ReleaseProgress[] = [];
    let latestProgress = cloneProgress(record.progress);
    let error: ReleaseJobError | null;

    try {
      error = await this.execution.execute(record, async (progress) => {
        latestProgress = cloneProgress(progress);
        events.push(latestProgress);
      });
    } catch (cause) {
      const message = redactSensitiveText(
        cause instanceof Error ? cause.message : '发布同步执行失败。',
      );
      error = { code: 'EXECUTION_FAILED', message, retryable: false };
      record.error = error;
      record.progress = {
        ...record.progress,
        stage: 'failed',
        sequence: record.progress.sequence + 1,
        message: '发布同步执行失败。',
        updatedAt: new Date().toISOString(),
      };
      latestProgress = cloneProgress(record.progress);
      events.push(latestProgress);
    }

    return {
      jobId: record.jobId,
      mode: record.mode,
      releaseUnit: { ...record.releaseUnit },
      progress: latestProgress,
      events,
      error: error
        ? {
            ...error,
            message: redactSensitiveText(error.message),
          }
        : null,
    };
  }
}

function cloneProgress(progress: ReleaseProgress): ReleaseProgress {
  return {
    ...progress,
    releaseUnit: { ...progress.releaseUnit },
    taskStatuses: progress.taskStatuses ? { ...progress.taskStatuses } : undefined,
    logs: progress.logs?.map((entry) => ({
      ...entry,
      message: redactSensitiveText(entry.message),
    })),
  };
}
