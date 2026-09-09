import { Injectable } from '@nestjs/common';
import { isJenkinsReady, readReleaseAutomationConfig } from './release-automation.config';
import {
  RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH,
  RELEASE_AUTOMATION_TAG_PATTERN,
} from './release-automation.constants';
import { payloadHash, redactSensitiveText } from './release-automation.security';
import { ReleaseAutomationService } from './release-automation.service';
import type {
  ReleaseJobError,
  ReleaseJobRecord,
  ReleaseProgress,
  ReleaseStage,
  ReleaseTaskKey,
  ReleaseTaskStatus,
} from './release-automation.types';

const ALL_RELEASE_TASKS: ReleaseTaskKey[] = [
  'git-tag',
  'github-merge',
  'jenkins',
  'release-docs',
  'modify-log',
  'feishu',
];

type ReleaseAutomationConfig = ReturnType<typeof readReleaseAutomationConfig>;
type TaskStatuses = Record<ReleaseTaskKey, ReleaseTaskStatus>;

type ExecutionContext = {
  record: ReleaseJobRecord;
  update: (progress: ReleaseProgress) => Promise<void>;
  selected: Set<ReleaseTaskKey>;
  taskStatuses: TaskStatuses;
  config?: ReleaseAutomationConfig;
  tag?: string;
  sideEffectGate: string;
  progressMessage?: string;
  expectedTargetSha?: string;
  expectedSourceSha?: string;
  completedMergeSources: number;
};

interface TaskProgressOptions {
  stage: ReleaseStage;
  percent: number;
  task?: ReleaseTaskKey;
  message: string | ((context: ExecutionContext) => string);
}

function TaskProgress(options: TaskProgressOptions): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const originalMethod = descriptor.value as (context: ExecutionContext) => Promise<void>;
    descriptor.value = async function (this: unknown, context: ExecutionContext): Promise<void> {
      await originalMethod.call(this, context);
      if (options.task && !context.selected.has(options.task)) return;
      const message =
        typeof options.message === 'function' ? options.message(context) : options.message;
      await publishProgress(
        context.update,
        context.record,
        options.stage,
        options.percent,
        message,
        context.taskStatuses,
      );
      context.progressMessage = undefined;
    } as typeof descriptor.value;
    return descriptor;
  };
}

/** 已知的步骤级业务失败，交给 execute 的外层统一转换为 Job 错误。 */
class ReleaseAutomationStepError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: string,
    message: string,
    readonly stage: 'preflight_blocked' | 'partial-success' = 'preflight_blocked',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReleaseAutomationStepError';
  }
}

@Injectable()
export class ReleaseAutomationExecutionService {
  constructor(private readonly releaseService: ReleaseAutomationService) {}

  /** 发版执行总入口，step 内异常由外层统一收口。 */
  async execute(
    record: ReleaseJobRecord,
    update: (progress: ReleaseProgress) => Promise<void>,
  ): Promise<ReleaseJobError | null> {
    return this.runExecutionPipeline(record, update)
      .then(() => null)
      .catch((error) => this.handleExecutionError(record, update, error));
  }

  /** 构造一个不写入状态的进度对象，供调用方或测试预览阶段信息。 */
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

  /** 计算当前 release unit 与 mode 的稳定计划哈希。 */
  hashPlan(record: ReleaseJobRecord): string {
    return payloadHash({ releaseUnit: record.releaseUnit, mode: record.mode });
  }

  /** 按固定顺序调用所有发版步骤，异常不在这里吞掉。 */
  private async runExecutionPipeline(
    record: ReleaseJobRecord,
    update: (progress: ReleaseProgress) => Promise<void>,
  ): Promise<void> {
    const context = this.createExecutionContext(record, update);
    await this.initializeExecutionStep(context); // 初始化任务状态与 planned 进度
    await this.loadConfigurationStep(context); // 读取并校验发布配置
    await this.validateTagStep(context); // 校验发布 tag 格式
    await this.executeGitTagStep(context); // 创建或核验 Git tag
    await this.prepareMergeStep(context); // 读取 target 和 dev/master 的初始 SHA
    await this.mergeSourceStep(context); // 执行 dev/master 到目标分支的合并
    await this.finalizeMergeStep(context); // 汇总分支合并结果并更新进度
    await this.executeJenkinsStep(context); // 执行或规划 Jenkins 打包
    await this.executeReleaseDocsStep(context); // 执行发布文档步骤或抛出阻断
    await this.executeModifyLogStep(context); // 执行 modify-log 步骤或抛出阻断
    await this.executeFeishuStep(context); // 执行 Feishu 步骤或抛出阻断
    await this.completeExecutionStep(context); // 写入 completed 终态
  }

  /** 创建本次执行共享的上下文，保存任务选择、SHA 链和进度状态。 */
  private createExecutionContext(
    record: ReleaseJobRecord,
    update: (progress: ReleaseProgress) => Promise<void>,
  ): ExecutionContext {
    const selected = new Set<ReleaseTaskKey>(record.selectedTasks ?? ALL_RELEASE_TASKS);
    return {
      record,
      update,
      selected,
      taskStatuses: buildTaskStatuses(selected),
      sideEffectGate: record.idempotencyKey,
      completedMergeSources: 0,
    };
  }

  /** 记录任务初始 planned 进度并初始化服务端 sequence。 */
  @TaskProgress({ stage: 'planned', percent: 5, message: '发布任务已创建。' })
  private async initializeExecutionStep(context: ExecutionContext): Promise<void> {
    void context;
  }

  /** 读取页面覆盖后的发布配置，失败时抛出 CONFIG_INVALID。 */
  private async loadConfigurationStep(context: ExecutionContext): Promise<void> {
    try {
      context.config = readReleaseAutomationConfig(context.record.pageConfig!);
    } catch (error) {
      this.throwStepError(
        'CONFIG_INVALID',
        error instanceof Error ? error.message : '发布配置无效。',
        undefined,
        error,
      );
    }
  }

  /** 校验 release tag 并写入执行上下文。 */
  private async validateTagStep(context: ExecutionContext): Promise<void> {
    const tag = context.record.releaseUnit.gitTag ?? context.record.releaseUnit.version;
    if (!RELEASE_AUTOMATION_TAG_PATTERN.test(tag)) {
      this.throwStepError('VERSION_INVALID', 'gitTag 格式无效。');
    }
    context.tag = tag;
  }

  /** 执行 tag 的创建/核验，并记录候选 SHA。 */
  @TaskProgress({
    stage: 'candidate_prepared',
    percent: 20,
    task: 'git-tag',
    message: (context) => context.progressMessage ?? 'Git tag 已准备。',
  })
  private async executeGitTagStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('git-tag')) return;
    try {
      const result = await this.releaseService.ensureTag({
        repository: context.record.releaseUnit.repository,
        tag: context.tag!,
        sourceBranch: RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH,
        mode: context.record.mode,
        sideEffectGate: context.sideEffectGate,
        config: context.config,
      });
      context.record.releaseUnit.candidateSha = result.sha;
      context.taskStatuses['git-tag'] = result.status === 'planned' ? 'planned' : 'succeeded';
      context.progressMessage = tagProgressMessage(context.tag!, result.status, result.sha);
    } catch (error) {
      context.taskStatuses['git-tag'] = 'blocked';
      this.throwStepError(
        'TAG_FAILED',
        error instanceof Error ? error.message : 'Git tag 创建失败。',
        undefined,
        error,
      );
    }
  }

  /** 读取目标和 tag 来源分支的初始 SHA，并检查来源 tag 快照是否漂移。 */
  private async prepareMergeStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('github-merge')) return;
    try {
      const [target, source] = await Promise.all([
        this.releaseService.getBranchRef({
          repository: context.record.releaseUnit.repository,
          branch: context.record.releaseUnit.targetBranch,
          config: context.config,
        }),
        this.releaseService.getBranchRef({
          repository: context.record.releaseUnit.repository,
          branch: RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH,
          config: context.config,
        }),
      ]);
      context.expectedTargetSha = target.sha;
      context.expectedSourceSha = source.sha;
    } catch (error) {
      context.taskStatuses['github-merge'] = 'blocked';
      this.throwMergeError(context, error);
    }
  }

  /** 执行单一来源分支到目标分支的 merge，并推进 after SHA。 */
  private async mergeSourceStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('github-merge')) return;
    try {
      const result = await this.releaseService.mergeBranch({
        repository: context.record.releaseUnit.repository,
        targetBranch: context.record.releaseUnit.targetBranch,
        sourceBranch: RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH,
        mode: context.record.mode,
        sideEffectGate: context.sideEffectGate,
        config: context.config,
        expectedTargetSha: context.expectedTargetSha,
        expectedSourceSha: context.expectedSourceSha,
      });
      context.expectedTargetSha = result.afterSha;
      if (result.status !== 'planned') context.completedMergeSources += 1;
    } catch (error) {
      context.taskStatuses['github-merge'] = 'blocked';
      this.throwMergeError(context, error);
    }
  }

  /** 根据 merge 结果写入 task status 和 branch_plan_ready 进度。 */
  @TaskProgress({
    stage: 'branch_plan_ready',
    percent: 35,
    task: 'github-merge',
    message: (context) => context.progressMessage ?? '分支合并已准备。',
  })
  private async finalizeMergeStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('github-merge')) return;
    try {
      context.taskStatuses['github-merge'] =
        context.record.mode === 'dry-run' ? 'planned' : 'succeeded';
      context.progressMessage =
        context.record.mode === 'dry-run'
          ? `${context.record.releaseUnit.targetBranch} 的 ${RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH} 合并计划已生成，dry-run 未调用 Merge API。`
          : `${RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH} 已按 SHA 校验合并到 ${context.record.releaseUnit.targetBranch}。`;
    } catch (error) {
      context.taskStatuses['github-merge'] = 'blocked';
      this.throwMergeError(context, error);
    }
  }

  /** 执行 Jenkins 打包，并校验最终 Pipeline 结果。 */
  @TaskProgress({
    stage: 'jenkins_verified',
    percent: 60,
    task: 'jenkins',
    message: (context) => context.progressMessage ?? 'Jenkins 任务已准备。',
  })
  private async executeJenkinsStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('jenkins')) return;
    if (!isJenkinsReady(context.config!)) {
      context.taskStatuses.jenkins = 'blocked';
      this.throwStepError(
        'JENKINS_BLOCKED',
        'Jenkins 凭据或完整 Pipeline endpoint 待配置，保持 blocked。',
      );
    }
    const result = await this.releaseService.packageWithJenkins(context.config!);
    if (result.status !== 'verified') {
      context.taskStatuses.jenkins = 'blocked';
      this.throwStepError('JENKINS_FAILED', result.reason ?? 'Jenkins 打包失败.');
    }
    context.taskStatuses.jenkins = 'succeeded';
    context.progressMessage = `Jenkins 已完成，Pipeline tag: ${result.pipelineTag ?? 'unknown'}。`;
  }

  /** 当前未实现，选中后抛出发布文档相关阻断。 */
  private async executeReleaseDocsStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('release-docs')) return;
    this.throwStepError(
      'REMOTE_DOCS_PENDING',
      'GitHub 提交日志、AI 文档、database tree commit 和 Feishu 输出尚未配置完整，已停止后续真实副作用。',
    );
  }

  /** 当前未实现，选中后抛出 modify-log 相关阻断。 */
  private async executeModifyLogStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('modify-log')) return;
    this.throwStepError(
      'REMOTE_DOCS_PENDING',
      'GitHub 提交日志、AI 文档、database tree commit 和 Feishu 输出尚未配置完整，已停止后续真实副作用。',
    );
  }

  /** 当前未实现，选中后抛出 Feishu 输出相关阻断。 */
  private async executeFeishuStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('feishu')) return;
    this.throwStepError(
      'REMOTE_DOCS_PENDING',
      'GitHub 提交日志、AI 文档、database tree commit 和 Feishu 输出尚未配置完整，已停止后续真实副作用。',
    );
  }

  /** 所有步骤成功后写入 completed 终态。 */
  @TaskProgress({
    stage: 'completed',
    percent: 100,
    message: (context) =>
      context.record.mode === 'dry-run'
        ? 'Git tag/分支合并计划已完成，未产生远程写副作用。'
        : 'Git tag/分支合并真实执行已完成。',
  })
  private async completeExecutionStep(context: ExecutionContext): Promise<void> {
    void context;
  }

  /** 将已知 step 异常转换为结构化 Job 错误并推进失败进度。 */
  private handleExecutionError(
    record: ReleaseJobRecord,
    update: (progress: ReleaseProgress) => Promise<void>,
    error: unknown,
  ): Promise<ReleaseJobError> {
    if (!(error instanceof ReleaseAutomationStepError)) throw error;
    const taskStatuses = (record.progress.taskStatuses ??
      buildTaskStatuses(new Set(record.selectedTasks ?? ALL_RELEASE_TASKS))) as TaskStatuses;
    return publishProgress(update, record, error.stage, 0, error.message, taskStatuses).then(
      () => ({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }),
    );
  }

  /** 将 merge 读 ref、SHA 竞态或远程合并异常转换为统一 merge 错误。 */
  private throwMergeError(context: ExecutionContext, error: unknown): never {
    this.throwStepError(
      'GITHUB_MERGE_FAILED',
      error instanceof Error ? error.message : 'GitHub 远程合并失败。',
      context.completedMergeSources > 0 ? 'partial-success' : 'preflight_blocked',
      error,
    );
  }

  /** 创建携带错误码、终态阶段和原始 cause 的 step 异常。 */
  private throwStepError(
    code: string,
    message: string,
    stage: 'preflight_blocked' | 'partial-success' = 'preflight_blocked',
    cause?: unknown,
  ): never {
    throw new ReleaseAutomationStepError(code, message, stage, { cause });
  }
}

/** 根据 tag 创建结果生成脱敏后的候选进度文案。 */
function tagProgressMessage(
  tag: string,
  status: 'created' | 'skipped' | 'planned' | 'reconciled',
  sha: string,
): string {
  if (status === 'planned') return `Git tag ${tag} 计划指向 ${sha}，dry-run 未创建。`;
  if (status === 'created') return `Git tag ${tag} 已创建。`;
  if (status === 'reconciled') return `Git tag ${tag} 已在并发创建后核验存在。`;
  return `Git tag ${tag} 已存在，跳过创建。`;
}

/** 为所有任务建立初始 pending/skipped 状态表。 */
function buildTaskStatuses(selected: Set<ReleaseTaskKey>): TaskStatuses {
  return Object.fromEntries(
    ALL_RELEASE_TASKS.map((task) => [task, selected.has(task) ? 'pending' : 'skipped']),
  ) as TaskStatuses;
}

/** 原子推进 record progress、sequence、日志和 task status，并通知外部持久化层。 */
async function publishProgress(
  update: (progress: ReleaseProgress) => Promise<void>,
  record: ReleaseJobRecord,
  stage: ReleaseStage,
  percent: number,
  message: string,
  taskStatuses?: TaskStatuses,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const nextLog = {
    sequence: (record.logs?.at(-1)?.sequence ?? 0) + 1,
    timestamp: updatedAt,
    level: stage === 'failed' || stage === 'preflight_blocked' ? 'error' : 'info',
    message: redactSensitiveText(message),
  } as const;
  record.logs = [...(record.logs ?? []), nextLog].slice(-500);
  record.progress = {
    stage,
    sequence: record.progress.sequence + 1,
    percent,
    message,
    updatedAt,
    releaseUnit: record.releaseUnit,
    ...(taskStatuses ? { taskStatuses } : {}),
    logs: record.logs,
  };
  record.updatedAt = updatedAt;
  await update(record.progress);
}
