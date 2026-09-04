import { Injectable } from '@nestjs/common';
import { isJenkinsReady, readReleaseAutomationConfig } from './release-automation.config';
import { RELEASE_AUTOMATION_VERSION } from './release-automation.constants';
import { payloadHash } from './release-automation.security';
import type {
  ReleaseJobError,
  ReleaseJobRecord,
  ReleaseProgress,
  ReleaseStage,
} from './release-automation.types';

@Injectable()
export class ReleaseAutomationExecutionService {
  async execute(
    record: ReleaseJobRecord,
    update: (progress: ReleaseProgress) => Promise<void>,
  ): Promise<ReleaseJobError | null> {
    await updateProgress(update, record, 'planned', 5, '发布计划已创建。');
    let config;
    try {
      config = readReleaseAutomationConfig();
    } catch (error) {
      return this.fail(
        update,
        record,
        'CONFIG_INVALID',
        error instanceof Error ? error.message : '发布配置无效。',
      );
    }
    if (record.releaseUnit.version !== RELEASE_AUTOMATION_VERSION) {
      return this.fail(
        update,
        record,
        'VERSION_INVALID',
        `版本必须固定为 ${RELEASE_AUTOMATION_VERSION}。`,
      );
    }
    if (config.githubAllowedRepositories.length === 0) {
      return this.fail(
        update,
        record,
        'GITHUB_BLOCKED',
        'GitHub repository allowlist 待配置，保持 blocked。',
      );
    }
    if (!isJenkinsReady(config) || !config.jenkinsCredentialRef) {
      return this.fail(
        update,
        record,
        'JENKINS_BLOCKED',
        'Jenkins 凭据或完整 Pipeline endpoint 待配置，保持 blocked。',
      );
    }
    await updateProgress(
      update,
      record,
      'branch_plan_ready',
      35,
      'dry-run 计划已准备；远程合并未调用。',
    );
    await updateProgress(
      update,
      record,
      'candidate_prepared',
      60,
      '候选 release unit 已冻结；未下载代码。',
    );
    await updateProgress(
      update,
      record,
      'docs_ready',
      85,
      'dry-run 产物计划已准备，未写入正式 artifact。',
    );
    await updateProgress(
      update,
      record,
      'completed',
      100,
      'dry-run 完成；所有副作用接口均未调用。',
    );
    return null;
  }

  createProgress(
    record: ReleaseJobRecord,
    stage: ReleaseStage,
    percent: number,
    message: string,
  ): ReleaseProgress {
    return {
      stage,
      sequence: record.progress.sequence,
      percent,
      message,
      updatedAt: new Date().toISOString(),
      releaseUnit: record.releaseUnit,
    };
  }

  hashPlan(record: ReleaseJobRecord): string {
    return payloadHash({ releaseUnit: record.releaseUnit, mode: record.mode });
  }

  private async fail(
    update: (progress: ReleaseProgress) => Promise<void>,
    record: ReleaseJobRecord,
    code: string,
    message: string,
  ): Promise<ReleaseJobError> {
    await updateProgress(update, record, 'preflight_blocked', 0, message);
    return { code, message, retryable: false };
  }
}

async function updateProgress(
  update: (progress: ReleaseProgress) => Promise<void>,
  record: ReleaseJobRecord,
  stage: ReleaseStage,
  percent: number,
  message: string,
): Promise<void> {
  record.progress = {
    stage,
    sequence: record.progress.sequence + 1,
    percent,
    message,
    updatedAt: new Date().toISOString(),
    releaseUnit: record.releaseUnit,
  };
  record.updatedAt = record.progress.updatedAt;
  await update(record.progress);
}
