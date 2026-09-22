import { Injectable, Optional } from '@nestjs/common';
import { isJenkinsReady, readReleaseAutomationConfig } from './release-automation.config';
import { ReleaseDocsService } from './release-docs.service';
import { RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH } from './release-automation.constants';
import { payloadHash, redactSensitiveText } from './release-automation.security';
import { ReleaseAutomationService, type ModifyLogPreparation } from './release-automation.service';
import type {
  ReleaseJobError,
  ReleaseJobRecord,
  ReleaseProgress,
  ReleaseDocsResult,
  ReleaseStage,
  ReleaseTaskKey,
  ReleaseTaskStatus,
  ReleasePullRequest,
} from './release-automation.types';

const ALL_RELEASE_TASKS: ReleaseTaskKey[] = [
  'git-tag',
  'github-merge',
  'jenkins',
  'release-docs',
  'modify-log',
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
  releaseDocs?: ReleaseDocsResult;
  modifyLog?: ModifyLogPreparation;
  sideEffectGate: string;
  progressMessage?: string;
  expectedTargetSha?: string;
  expectedSourceSha?: string;
  pullRequest?: ReleasePullRequest;
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
      try {
        await originalMethod.call(this, context);
      } catch (error) {
        if (options.task) {
          context.taskStatuses[options.task] = 'blocked';
          context.record.progress.taskStatuses = context.taskStatuses;
        }
        throw error;
      }
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
  constructor(
    private readonly releaseService: ReleaseAutomationService,
    @Optional() private readonly releaseDocsService?: ReleaseDocsService,
  ) {}

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

  /** 包装单个步骤，记录开始、结果和耗时；未选择的任务明确记录跳过。 */
  private async runLoggedStep(
    context: ExecutionContext,
    label: string,
    step: () => Promise<void>,
    task?: ReleaseTaskKey,
  ): Promise<void> {
    if (task && !context.selected.has(task)) {
      await appendExecutionLog(context, `跳过：${label}（任务未选择）。`);
      return;
    }
    const startedAt = Date.now();
    await appendExecutionLog(context, `开始：${label}。`);
    try {
      await step();
      await appendExecutionLog(context, `完成：${label}，耗时 ${Date.now() - startedAt}ms。`);
    } catch (error) {
      try {
        await appendExecutionLog(
          context,
          `失败：${label}，耗时 ${Date.now() - startedAt}ms，${toSafeLogDetail(error)}。`,
          'error',
        );
      } catch {
        // 保留原始步骤错误，日志持久化失败不覆盖根因。
      }
      throw error;
    }
  }

  /** 按固定顺序调用所有发版步骤，异常不在这里吞掉。 */
  private async runExecutionPipeline(
    record: ReleaseJobRecord,
    update: (progress: ReleaseProgress) => Promise<void>,
  ): Promise<void> {
    const context = this.createExecutionContext(record, update);
    await this.runLoggedStep(context, '初始化任务', () => this.initializeExecutionStep(context));
    await this.runLoggedStep(context, '读取发布配置', () => this.loadConfigurationStep(context));
    await this.runLoggedStep(context, '校验任务依赖', () =>
      this.validateTaskDependenciesStep(context),
    );
    await this.runLoggedStep(context, '准备 Git tag', () => this.prepareTagStep(context));
    await this.runLoggedStep(
      context,
      '执行 Git tag',
      () => this.executeGitTagStep(context),
      'git-tag',
    );
    await this.runLoggedStep(
      context,
      '读取 PR 前分支',
      () => this.preparePullRequestStep(context),
      'github-merge',
    );
    await this.runLoggedStep(
      context,
      '提交或复用 GitHub PR',
      () => this.submitPullRequestStep(context),
      'github-merge',
    );
    await this.runLoggedStep(
      context,
      '确认 Pull Request',
      () => this.finalizePullRequestStep(context),
      'github-merge',
    );
    if (context.record.mode === 'apply' && context.selected.has('github-merge')) {
      await this.runLoggedStep(
        context,
        '等待 GitHub PR 合并',
        () => this.pauseForPullRequestStep(context),
        'github-merge',
      );
      return;
    }
    await this.runLoggedStep(
      context,
      '执行 Jenkins 打包',
      () => this.executeJenkinsStep(context),
      'jenkins',
    );
    await this.runLoggedStep(
      context,
      '读取 modify-log SQL',
      () => this.executeModifyLogStep(context),
      'modify-log',
    );
    await this.runLoggedStep(
      context,
      '生成并发布更新日志',
      () => this.executeReleaseDocsStep(context),
      'release-docs',
    );
    await this.runLoggedStep(
      context,
      '执行 Feishu 输出',
      () => this.executeFeishuStep(context),
      'feishu',
    );
    await this.runLoggedStep(context, '完成发布任务', () => this.completeExecutionStep(context));
  }

  /** 创建本次执行共享的上下文，保存任务选择、SHA 链和进度状态。 */
  private createExecutionContext(
    record: ReleaseJobRecord,
    update: (progress: ReleaseProgress) => Promise<void>,
  ): ExecutionContext {
    const selected = new Set<ReleaseTaskKey>(record.selectedTasks ?? ALL_RELEASE_TASKS);
    selected.add('release-docs');
    selected.add('modify-log');
    return {
      record,
      update,
      selected,
      taskStatuses: buildTaskStatuses(selected),
      sideEffectGate: record.idempotencyKey,
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

  /** 在产生远程副作用前阻断尚未接通的后置任务。 */
  private async validateTaskDependenciesStep(context: ExecutionContext): Promise<void> {
    if (context.selected.has('feishu')) {
      context.taskStatuses.feishu = 'blocked';
      context.record.progress.taskStatuses = context.taskStatuses;
      this.throwStepError('FEISHU_OUTPUT_UNSUPPORTED', '发布 Feishu 文档目标尚未配置。');
    }
  }

  private async prepareTagStep(context: ExecutionContext): Promise<void> {
    context.tag = context.record.releaseUnit.gitTag ?? context.record.releaseUnit.version;
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
      await appendExecutionLog(
        context,
        `Git tag ${context.tag}：${result.status}，candidate SHA ${result.sha}。`,
      );
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

  /** 读取 PR 目标和固定来源分支的初始 SHA，并检查发布快照是否漂移。 */
  private async preparePullRequestStep(context: ExecutionContext): Promise<void> {
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
      await appendExecutionLog(
        context,
        `GitHub ref 已读取：${context.record.releaseUnit.targetBranch}=${target.sha}，${RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH}=${source.sha}。`,
      );
    } catch (error) {
      context.taskStatuses['github-merge'] = 'blocked';
      this.throwPullRequestError(error);
    }
  }

  /** 创建或复用唯一的 open PR，不执行本地 Git 或远程合并。 */
  private async submitPullRequestStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('github-merge')) return;
    try {
      const result = await this.releaseService.createOrReusePullRequest({
        repository: context.record.releaseUnit.repository,
        targetBranch: context.record.releaseUnit.targetBranch,
        sourceBranch: RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH,
        releaseTag: context.tag,
        mode: context.record.mode,
        sideEffectGate: context.sideEffectGate,
        config: context.config,
        expectedTargetSha: context.expectedTargetSha,
        expectedSourceSha: context.expectedSourceSha,
      });
      context.expectedTargetSha = result.targetSha;
      context.pullRequest = result.pullRequest;
      if (result.pullRequest) context.record.progress.pullRequest = result.pullRequest;
      await appendExecutionLog(
        context,
        result.pullRequest
          ? `GitHub PR：${result.status}，#${result.pullRequest.number} ${result.pullRequest.url}，来源 SHA ${result.pullRequest.headSha}。`
          : `GitHub PR：${result.status}，目标 ${result.targetBranch}，来源 SHA ${result.sourceSha}。`,
      );
    } catch (error) {
      context.taskStatuses['github-merge'] = 'blocked';
      this.throwPullRequestError(error);
    }
  }

  /** 根据 PR 结果更新任务状态；apply 随后进入人工终态。 */
  @TaskProgress({
    stage: 'branch_plan_ready',
    percent: 35,
    task: 'github-merge',
    message: (context) => context.progressMessage ?? 'GitHub PR 已准备。',
  })
  private async finalizePullRequestStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('github-merge')) return;
    const conflicted = isPullRequestConflicted(context.pullRequest);
    context.taskStatuses['github-merge'] =
      context.record.mode === 'dry-run' ? 'planned' : conflicted ? 'blocked' : 'succeeded';
    context.progressMessage =
      context.record.mode === 'dry-run'
        ? `${RELEASE_AUTOMATION_MERGE_SOURCE_BRANCH} → ${context.record.releaseUnit.targetBranch} 的 PR 计划已生成，dry-run 未创建 PR。`
        : conflicted
          ? `GitHub PR #${context.pullRequest?.number ?? 'unknown'} 检测到不可合并状态，已拒绝继续执行。`
          : `GitHub PR #${context.pullRequest?.number ?? 'unknown'} 已${context.pullRequest ? '提交/复用' : '准备'}，等待人工审核并合并。`;
  }

  /** 将 apply 任务停在人工终态，避免自动执行 Jenkins 及其后的发布步骤。 */
  @TaskProgress({
    stage: 'manual_intervention',
    percent: 35,
    task: 'github-merge',
    message: (context) => context.progressMessage ?? '等待 GitHub PR 合并。',
  })
  private async pauseForPullRequestStep(context: ExecutionContext): Promise<void> {
    context.progressMessage = context.pullRequest
      ? isPullRequestConflicted(context.pullRequest)
        ? `GitHub PR #${context.pullRequest.number} 存在合并冲突或不可合并状态，已拒绝继续执行。请在 GitHub 解决冲突并重新提交发布任务；不会触发 Jenkins、modify-log 或 Feishu。`
        : `请在 GitHub 审核并合并 PR #${context.pullRequest.number}（${context.pullRequest.url}）。PR 合并前不会触发 Jenkins、modify-log 或 Feishu；合并后需重新提交发布任务。`
      : '请在 GitHub 完成 Pull Request 人工处理；当前任务不会继续后续发布步骤。';
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
    await appendExecutionLog(
      context,
      `Jenkins：${result.status}，Pipeline tag ${result.pipelineTag ?? 'unknown'}。`,
    );
  }

  /** 收集发布事实并生成只读 Markdown，AI 失败时使用本地摘要。 */
  @TaskProgress({
    stage: 'docs_ready',
    percent: 30,
    task: 'release-docs',
    message: (context) => context.progressMessage ?? '发布 Markdown 已准备。',
  })
  private async executeReleaseDocsStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('release-docs')) return;
    if (!this.releaseDocsService || !context.record.releaseDocs) {
      context.taskStatuses['release-docs'] = 'blocked';
      this.throwStepError('RELEASE_DOCS_INPUT_MISSING', '发布文档配置未完整提供。');
    }
    try {
      const result = await this.releaseDocsService.generate({
        repository: context.record.releaseUnit.repository,
        releaseUnit: context.record.releaseUnit,
        config: context.config!,
        runtime: context.record.runtime,
        input: context.record.releaseDocs,
        publish: {
          mode: context.record.mode,
          sideEffectGate: context.sideEffectGate,
        },
        progress: async (message) => {
          context.progressMessage = message;
          await publishProgress(
            context.update,
            context.record,
            'docs_ready',
            30,
            message,
            context.taskStatuses,
          );
        },
      });
      context.releaseDocs = result;
      context.record.progress.releaseDocs = result;
      context.record.progress.degraded = result.degraded;
      context.record.progress.warnings = result.warnings;
      await appendExecutionLog(
        context,
        `发布 docs：提交 ${result.commitCount} 条，AI ${result.degraded ? '降级' : '可用'}，环境差异 ${result.environment?.changedKeys ?? 0} 项，update-log ${result.publication?.status ?? '未请求'}。`,
        result.degraded ? 'warn' : 'info',
      );
      context.taskStatuses['release-docs'] = 'succeeded';
      const publicationMessage = result.publication
        ? ` 更新日志 ${result.publication.path}（${result.publication.status}）。`
        : '';
      context.progressMessage = result.degraded
        ? `发布 Markdown 已生成，AI 不可用，已使用本地摘要。${publicationMessage}`
        : `发布 Markdown 已生成，包含 ${result.commitCount} 个提交事实。${publicationMessage}`;
    } catch (error) {
      context.taskStatuses['release-docs'] = 'blocked';
      this.throwStepError(
        'RELEASE_DOCS_FAILED',
        error instanceof Error ? error.message : '发布 Markdown 生成失败。',
        undefined,
        error,
      );
    }
  }

  /** 读取并渲染 modify-log，apply 时归档 SQL，dry-run 只生成预览。 */
  @TaskProgress({
    stage: 'modify_log_clear_pending',
    percent: 75,
    task: 'modify-log',
    message: (context) => context.progressMessage ?? 'modify-log SQL 已准备。',
  })
  private async executeModifyLogStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('modify-log')) return;
    try {
      const preparation = await this.releaseService.prepareModifyLog({
        releaseUnit: context.record.releaseUnit,
        mode: context.record.mode,
        config: context.config!,
        jobId: context.record.jobId,
      });
      context.modifyLog = preparation;
      await appendExecutionLog(
        context,
        `modify-log：已从 GitHub 读取 ${preparation.sourcePath ?? context.config?.modifyLogPath ?? 'modify-log.sql'}，ref ${preparation.sourceRef ?? 'unknown'}，checksum ${preparation.sourceChecksum}，未生成本地 var 归档。`,
      );
      const readStatus = preparation.artifact
        ? ('archived' as const)
        : context.record.mode === 'apply'
          ? ('read' as const)
          : ('planned' as const);
      context.record.progress.modifyLog = {
        status: readStatus,
        sourceChecksum: preparation.sourceChecksum,
        generation: preparation.generation,
        recordCount: preparation.recordCount,
        artifactId: preparation.artifact?.artifactId,
        artifactChecksum: preparation.artifact?.artifactChecksum,
      };
      context.taskStatuses['modify-log'] =
        preparation.artifact || context.record.mode === 'apply' ? 'succeeded' : 'planned';
      context.progressMessage = preparation.artifact
        ? 'modify-log SQL 原文已归档。'
        : context.record.mode === 'apply'
          ? 'modify-log SQL 原文已从 GitHub 读取，将随 update-log 写入。'
          : 'modify-log SQL 原文已读取。';
    } catch (error) {
      context.taskStatuses['modify-log'] = 'blocked';
      this.throwStepError(
        'MODIFY_LOG_FAILED',
        error instanceof Error ? error.message : 'modify-log SQL 处理失败。',
        undefined,
        error,
      );
    }
  }

  /** 当前未实现，选中后抛出 Feishu 输出相关阻断。 */
  private async executeFeishuStep(context: ExecutionContext): Promise<void> {
    if (!context.selected.has('feishu')) return;
    this.throwStepError('FEISHU_OUTPUT_UNSUPPORTED', '发布 Feishu 文档目标尚未配置。');
  }

  /** 所有步骤成功后写入 completed 终态。 */
  @TaskProgress({
    stage: 'completed',
    percent: 100,
    message: (context) =>
      context.record.mode === 'dry-run'
        ? 'Git tag/PR 计划已完成，未产生远程写副作用。'
        : 'Git tag 已执行，GitHub PR 流程已完成。',
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
    record.progress.taskStatuses = taskStatuses;
    return publishProgress(update, record, error.stage, 0, error.message, taskStatuses).then(
      () => ({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }),
    );
  }

  /** 将 ref 漂移、PR 冲突或远程 PR 异常转换为统一错误。 */
  private throwPullRequestError(error: unknown): never {
    this.throwStepError(
      'GITHUB_PR_FAILED',
      error instanceof Error ? error.message : 'GitHub Pull Request 提交失败。',
      'preflight_blocked',
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

function isPullRequestConflicted(pullRequest: ReleasePullRequest | undefined): boolean {
  return pullRequest?.mergeable === false || pullRequest?.mergeableState === 'dirty';
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

function toSafeLogDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message).replace(/\s+/g, ' ').slice(0, 300);
}

/** 追加有界、脱敏的执行事件日志，并立即同步当前 progress。 */
async function appendExecutionLog(
  context: ExecutionContext,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  const timestamp = new Date().toISOString();
  const nextLog = {
    sequence: (context.record.logs?.at(-1)?.sequence ?? 0) + 1,
    timestamp,
    level,
    message: redactSensitiveText(message).slice(0, 1000),
  } as const;
  context.record.logs = [...(context.record.logs ?? []), nextLog].slice(-500);
  context.record.progress = {
    ...context.record.progress,
    sequence: context.record.progress.sequence + 1,
    updatedAt: timestamp,
    logs: context.record.logs,
  };
  context.record.updatedAt = timestamp;
  await context.update(context.record.progress);
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
    ...(record.progress.releaseDocs ? { releaseDocs: record.progress.releaseDocs } : {}),
    ...(record.progress.modifyLog ? { modifyLog: record.progress.modifyLog } : {}),
    ...(record.progress.pullRequest ? { pullRequest: record.progress.pullRequest } : {}),
    ...(record.progress.degraded !== undefined ? { degraded: record.progress.degraded } : {}),
    ...(record.progress.warnings ? { warnings: record.progress.warnings } : {}),
    logs: record.logs,
  };
  record.updatedAt = updatedAt;
  await update(record.progress);
}
