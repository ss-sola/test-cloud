import { Injectable } from '@nestjs/common';
import { ProjectException } from '@nest-cloud/common';
import { OpenAiCompatibleClientService } from '../../client/ai/openai-compatible-client.service';
import {
  GitHubApiException,
  GitHubReleaseClientService,
  type GitHubCommitDetails,
  type GitHubContentsResult,
} from './github-release-client.service';
import { diffEnv } from './env-diff.util';
import { renderEnvConfigSql } from './env-sql.renderer';
import type { ReleaseAutomationConfig } from './release-automation.config';
import { ReleaseAutomationService, type ModifyLogPreparation } from './release-automation.service';
import { sha256, stableStringify } from './release-automation.security';
import type {
  EnvDiffResult,
  GitHubCommitSummary,
  ReleaseAiConfig,
  ReleaseDocsInput,
  ReleaseDocsPublication,
  ReleaseDocsResult,
  ReleaseMode,
  ReleaseRuntimeConfig,
  ReleaseUnit,
} from './release-automation.types';

interface ReleaseDocsOptions {
  repository: string;
  releaseUnit: ReleaseUnit;
  config: ReleaseAutomationConfig;
  runtime?: ReleaseRuntimeConfig;
  input: ReleaseDocsInput;
  modifyLog?: ModifyLogPreparation;
  publish?: {
    mode: ReleaseMode;
    sideEffectGate: string;
  };
  progress?: (message: string) => Promise<void>;
}

interface PublishUpdateLogOptions {
  repository: string;
  branch: string;
  previousTag?: string;
  currentTag: string;
  markdown: string;
  mode: ReleaseMode;
  sideEffectGate: string;
  config: ReleaseAutomationConfig;
  progress?: (message: string) => Promise<void>;
}

interface PublishedUpdateLog {
  publication: ReleaseDocsPublication;
  markdown: string;
}

type UpdateLogCommitIdentity = { kind: 'write'; runId: string } | { kind: 'legacy-write' };

interface FactSummary {
  text: string;
  factRefs: string[];
}

interface AiReleaseSummary {
  summary?: FactSummary[];
  environmentNotes?: FactSummary[];
  databaseNotes?: FactSummary[];
}

interface ReleaseFacts {
  commits: GitHubCommitSummary[];
  environment: {
    filePath: string;
    changedKeys: number;
    beforeChecksum: string;
    afterChecksum: string;
    diff: EnvDiffResult;
    configurationSql?: string;
  };
  database: {
    recordCount: number;
    sourceChecksum: string;
    content: string;
    path: string;
    ref?: string;
    blobSha?: string;
  };
}

const DEFAULT_AI_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_PROMPT_CHARACTERS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 50_000;
const DEFAULT_MAX_COMMITS = 100;
const MAX_SUMMARY_ITEMS = 5;
const MAX_AI_SQL_CHARACTERS = 20_000;

/** 自动读取相邻发布 tag 的事实，生成带来源引用的发布 Markdown。 */
@Injectable()
export class ReleaseDocsService {
  constructor(
    private readonly github: GitHubReleaseClientService,
    private readonly releaseService: ReleaseAutomationService,
    private readonly aiClient: OpenAiCompatibleClientService,
  ) {}

  async generate(options: ReleaseDocsOptions): Promise<ReleaseDocsResult> {
    const input = this.normalizeInput(options.input);
    const currentTag = options.releaseUnit.gitTag ?? options.releaseUnit.version;
    await options.progress?.('正在读取当前版本和上一版本 tag。');
    const tagRange = await this.resolveTagRange(options.repository, currentTag, options.config);
    const facts = await this.collectFacts({
      repository: options.repository,
      releaseUnit: options.releaseUnit,
      config: options.config,
      input,
      modifyLog: options.modifyLog,
      previousTag: tagRange.previous?.name,
      currentTag: tagRange.current.name,
      progress: options.progress,
    });
    const warnings: string[] = [];
    const aiSummary = await this.createAiSummary(
      options.runtime?.ai,
      facts,
      {
        repository: options.repository,
        previousTag: tagRange.previous?.name,
        currentTag: tagRange.current.name,
        previousSha: tagRange.previous?.sha,
        currentSha: tagRange.current.sha,
      },
      options.runtime,
      warnings,
      options.progress,
    );
    let markdown = this.renderMarkdown({
      repository: options.repository,
      previousTag: tagRange.previous?.name,
      currentTag: tagRange.current.name,
      previousSha: tagRange.previous?.sha,
      currentSha: tagRange.current.sha,
      facts,
      summary: aiSummary,
    });
    let publication: ReleaseDocsPublication | undefined;
    if (options.publish) {
      await options.progress?.('正在写入 update-log 到 GitHub。');
      const result = await this.publishUpdateLog({
        repository: options.repository,
        branch: options.releaseUnit.currentBranch,
        previousTag: tagRange.previous?.name,
        currentTag: tagRange.current.name,
        markdown,
        mode: options.publish.mode,
        sideEffectGate: options.publish.sideEffectGate,
        config: options.config,
        progress: options.progress,
      });
      publication = result.publication;
      markdown = result.markdown;
      await options.progress?.(`update-log 写入完成：${publication.status}。`);
    }
    const degraded = warnings.length > 0 || !aiSummary;
    return {
      status: degraded ? 'degraded' : 'succeeded',
      repository: options.repository,
      previousTag: tagRange.previous?.name,
      currentTag: tagRange.current.name,
      previousSha: tagRange.previous?.sha,
      resolvedSha: tagRange.current.sha,
      commitCount: facts.commits.length,
      mergeCommitCount: facts.commits.filter((commit) => commit.isMerge).length,
      markdown,
      markdownChecksum: sha256(markdown),
      degraded,
      warnings,
      publication,
      environment: facts.environment,
      database: {
        recordCount: facts.database.recordCount,
        sourceChecksum: facts.database.sourceChecksum,
        path: facts.database.path,
        ref: facts.database.ref,
        blobSha: facts.database.blobSha,
      },
    };
  }

  private async publishUpdateLog(options: PublishUpdateLogOptions): Promise<PublishedUpdateLog> {
    const rawPreviousTag = options.previousTag ?? 'initial';
    const rawCurrentTag = options.currentTag;
    const previousTag = toUpdateLogFilePart(rawPreviousTag);
    const currentTag = toUpdateLogFilePart(rawCurrentTag);
    const path = `update-log/${previousTag}-${currentTag}.md`;
    const expectedHeading = `# ${escapeMarkdown(rawPreviousTag)}-${escapeMarkdown(rawCurrentTag)}`;
    if (options.mode === 'dry-run') {
      return {
        publication: { status: 'planned', path, branch: options.branch },
        markdown: options.markdown,
      };
    }

    const runId = sha256(options.sideEffectGate).slice(0, 16);
    const pathKey = updateLogPathKey(path);
    const releaseKey = sha256(stableStringify([rawPreviousTag, rawCurrentTag])).slice(0, 16);
    const writeSubject = buildUpdateLogCommitSubject(previousTag, currentTag);
    const commitMessage = buildUpdateLogCommitMessage({
      subject: writeSubject,
      pathKey,
      releaseKey,
      runId,
    });
    const legacyCommitMessage = `docs: update log ${previousTag} -> ${currentTag}`;
    const [latestCommit] = await this.github.listCommits({
      repository: options.repository,
      ref: options.branch,
      path,
      config: options.config,
      perPage: 100,
      maxPages: 1,
    });

    if (!latestCommit) {
      const current = await this.getOptionalContents({
        repository: options.repository,
        path,
        ref: options.branch,
        config: options.config,
      });
      if (current) {
        throw new ProjectException('update-log 已存在但缺少可验证的提交历史，拒绝覆盖。', 409);
      }
      const publication = await this.github.putContents(
        {
          repository: options.repository,
          path,
          branch: options.branch,
          content: options.markdown,
          commitMessage,
          mode: options.mode,
          sideEffectGate: options.sideEffectGate,
          expectedBlobSha: null,
        },
        options.config,
      );
      return { publication, markdown: options.markdown };
    }

    const details = await this.github.getCommitDetails(
      options.repository,
      latestCommit.sha,
      options.config,
    );
    assertSingleFileUpdateLogCommit(details, path);
    const identity = identifyUpdateLogCommit({
      message: details.message,
      path,
      legacyMessage: legacyCommitMessage,
      writeSubject,
      releaseKey,
    });
    if (!identity) {
      throw new ProjectException('update-log 最近一次变更无法确认由发布流程生成，拒绝恢复。', 409);
    }

    const current = await this.getOptionalContents({
      repository: options.repository,
      path,
      ref: options.branch,
      config: options.config,
    });

    assertPublishedUpdateLogCommit(details, path);
    if (!current || details.files[0].sha !== current.sha) {
      throw new ProjectException('update-log 文件已被后续提交修改，拒绝重写历史。', 409);
    }
    if (!current.content.startsWith(`${expectedHeading}\n`)) {
      throw new ProjectException('update-log 内容与当前 release tag 不匹配，拒绝重写历史。', 409);
    }
    const expectedRef = `refs/heads/${options.branch}`;
    const head = await this.github.getRef(
      options.repository,
      `heads/${options.branch}`,
      options.config,
    );
    if (head.ref !== expectedRef || head.sha !== details.sha || head.objectType !== 'commit') {
      throw new ProjectException('update-log 自动提交不是 source branch HEAD，拒绝重写历史。', 409);
    }
    if (identity.kind === 'write' && identity.runId === runId) {
      return {
        publication: {
          status: 'unchanged',
          path,
          branch: options.branch,
          commitSha: details.sha,
        },
        markdown: current.content,
      };
    }

    await options.progress?.(
      '正在用 replacement commit 替换 source branch 顶端的自动 update-log。',
    );
    const replacement = await this.replaceUpdateLogCommit({
      repository: options.repository,
      branch: options.branch,
      path,
      markdown: options.markdown,
      commitMessage,
      mode: options.mode,
      sideEffectGate: options.sideEffectGate,
      config: options.config,
      previousCommit: details,
    });
    return {
      publication: {
        status: 'updated',
        path,
        branch: options.branch,
        commitSha: replacement.sha,
      },
      markdown: options.markdown,
    };
  }

  private async replaceUpdateLogCommit(options: {
    repository: string;
    branch: string;
    path: string;
    markdown: string;
    commitMessage: string;
    mode: ReleaseMode;
    sideEffectGate: string;
    config: ReleaseAutomationConfig;
    previousCommit: GitHubCommitDetails;
  }): Promise<{ sha: string }> {
    const parentSha = options.previousCommit.parents[0];
    const parent = await this.github.getCommitDetails(
      options.repository,
      parentSha,
      options.config,
    );
    const blob = await this.github.createBlob(
      {
        repository: options.repository,
        content: options.markdown,
        mode: options.mode,
        sideEffectGate: options.sideEffectGate,
      },
      options.config,
    );
    const tree = await this.github.createTree(
      {
        repository: options.repository,
        baseTreeSha: parent.treeSha,
        path: options.path,
        blobSha: blob.sha,
        mode: options.mode,
        sideEffectGate: options.sideEffectGate,
      },
      options.config,
    );
    const commit = await this.github.createCommit(
      {
        repository: options.repository,
        message: options.commitMessage,
        treeSha: tree.sha,
        parentSha,
        mode: options.mode,
        sideEffectGate: options.sideEffectGate,
      },
      options.config,
    );
    const updatedRef = await this.github.updateBranchRef(
      {
        repository: options.repository,
        branch: options.branch,
        sha: commit.sha,
        expectedSha: options.previousCommit.sha,
        mode: options.mode,
        sideEffectGate: options.sideEffectGate,
      },
      options.config,
    );
    if (updatedRef.sha !== commit.sha) {
      throw new ProjectException('GitHub source branch 未切换到 replacement commit。', 502);
    }
    return { sha: updatedRef.sha };
  }

  private async getOptionalContents(options: {
    repository: string;
    path: string;
    ref: string;
    config: ReleaseAutomationConfig;
  }): Promise<GitHubContentsResult | undefined> {
    try {
      return await this.github.getContents(
        { repository: options.repository, path: options.path, ref: options.ref },
        options.config,
      );
    } catch (error) {
      if (error instanceof GitHubApiException && error.getStatus() === 404) return undefined;
      throw error;
    }
  }

  private async resolveTagRange(
    repository: string,
    currentTag: string,
    config: ReleaseAutomationConfig,
  ): Promise<{
    previous?: { name: string; sha: string };
    current: { name: string; sha: string };
  }> {
    const tags = await this.github.listTags({ repository, config, perPage: 100, maxPages: 100 });
    const normalizedCurrent = currentTag.startsWith('refs/tags/')
      ? currentTag.slice('refs/tags/'.length)
      : currentTag;
    const currentIndex = tags.findIndex((tag) => tag.name === normalizedCurrent);
    if (currentIndex < 0) {
      throw new Error(`当前 tag ${normalizedCurrent} 不存在于 GitHub Tags API 返回结果。`);
    }
    return {
      current: tags[currentIndex],
      previous: tags[currentIndex + 1],
    };
  }

  private async collectFacts(options: {
    repository: string;
    releaseUnit: ReleaseUnit;
    config: ReleaseAutomationConfig;
    input: ReleaseDocsInput;
    modifyLog?: ModifyLogPreparation;
    previousTag?: string;
    currentTag: string;
    progress?: (message: string) => Promise<void>;
  }): Promise<ReleaseFacts> {
    await options.progress?.('正在通过 GitHub API 获取两个 tag 之间的提交记录。');
    const commits = (
      options.previousTag
        ? await this.github.compareCommits({
            repository: options.repository,
            base: `tags/${options.previousTag}`,
            head: `tags/${options.currentTag}`,
            config: options.config,
          })
        : await this.github.listCommits({
            repository: options.repository,
            ref: `tags/${options.currentTag}`,
            config: options.config,
            perPage: 100,
            maxPages: 1,
          })
    ).slice(0, DEFAULT_MAX_COMMITS);
    await options.progress?.('正在读取两个 tag 的环境文件并计算差异。');
    const environment = await this.collectEnvironmentFacts({
      repository: options.repository,
      config: options.config,
      previousTag: options.previousTag,
      currentTag: options.currentTag,
    });
    let preparation = options.modifyLog;
    if (preparation) {
      await options.progress?.('正在使用已读取的 modify-log SQL。');
    } else {
      await options.progress?.('正在从 GitHub 读取 modify-log.sql。');
      preparation = await this.releaseService.prepareModifyLog({
        releaseUnit: options.releaseUnit,
        mode: 'dry-run',
        config: options.config,
      });
    }
    return {
      commits,
      environment,
      database: {
        recordCount: preparation.recordCount,
        sourceChecksum: preparation.sourceChecksum,
        content: preparation.sql,
        path: preparation.sourcePath ?? options.config.modifyLogPath,
        ref: preparation.sourceRef,
        blobSha: preparation.sourceBlobSha,
      },
    };
  }

  private async collectEnvironmentFacts(options: {
    repository: string;
    config: ReleaseAutomationConfig;
    previousTag?: string;
    currentTag: string;
  }): Promise<ReleaseFacts['environment']> {
    const filePath = options.config.environmentFilePath;
    if (!filePath) throw new Error('环境文件路径未配置。');
    const afterFile = await this.github.getContents(
      { repository: options.repository, path: filePath, ref: `tags/${options.currentTag}` },
      options.config,
    );
    const beforeFile = options.previousTag
      ? await this.github.getContents(
          { repository: options.repository, path: filePath, ref: `tags/${options.previousTag}` },
          options.config,
        )
      : { content: '', checksum: sha256('') };
    const diff = diffEnv(beforeFile.content, afterFile.content);
    const configurationSql = options.config.environmentToSql
      ? renderEnvConfigSql(beforeFile.content, afterFile.content)
      : undefined;
    return {
      filePath,
      changedKeys: diff.added.length + diff.removed.length + diff.changed.length,
      beforeChecksum: diff.beforeChecksum,
      afterChecksum: diff.afterChecksum,
      diff,
      configurationSql,
    };
  }

  private async createAiSummary(
    ai: ReleaseAiConfig | undefined,
    facts: ReleaseFacts,
    context: {
      repository: string;
      previousTag?: string;
      currentTag: string;
      previousSha?: string;
      currentSha: string;
    },
    runtime: ReleaseRuntimeConfig | undefined,
    warnings: string[],
    progress?: (message: string) => Promise<void>,
  ): Promise<AiReleaseSummary | undefined> {
    if (!ai) {
      await progress?.('AI 未配置，使用本地发布摘要。');
      warnings.push('未配置 AI，使用本地发布摘要。');
      return undefined;
    }
    if (!ai.baseUrl || !ai.apiKey || !ai.model) {
      await progress?.('AI 配置不完整，使用本地发布摘要。');
      warnings.push('AI 配置不完整，需要 baseUrl、apiKey 和 model；使用本地发布摘要。');
      return undefined;
    }
    const factLedger = buildFactLedger(facts);
    const prompt = [
      '你是发布说明整理助手。只能依据下面的事实账本生成摘要，不得按人员筛选提交，不得编造测试、上线、用户影响或风险。',
      '只返回 JSON，不要 Markdown。每个条目必须包含 text 和 factRefs，factRefs 必须引用事实账本中的 ID。',
      '合并、rebase、cherry-pick 等纯集成提交不要作为工作成果摘要。',
      `发布上下文：${stableStringify(context)}`,
      `事实账本：${stableStringify(factLedger)}`,
    ].join('\n');
    const limits = runtime?.limits ?? {};
    await progress?.('正在调用 AI 整理提交、环境差异和 modify-log。');
    let aiFailureReason = '';
    const content = await this.aiClient.request({
      ai,
      prompt,
      systemMessage:
        '你只输出可解析的 JSON 对象，字段为 summary、environmentNotes、databaseNotes，数组元素包含 text 和 factRefs。',
      timeoutMs: limits.aiTimeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
      maxPromptCharacters: limits.maxPromptCharacters ?? DEFAULT_MAX_PROMPT_CHARACTERS,
      maxResponseCharacters: limits.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS,
      onFailure: (reason) => {
        aiFailureReason = reason;
        warnings.push(reason);
      },
    });
    if (!content) {
      await progress?.(aiFailureReason || 'AI 未返回可用内容，使用本地发布摘要。');
      if (!aiFailureReason) warnings.push('AI 未返回可用内容，使用本地发布摘要。');
      return undefined;
    }
    const parsed = parseAiSummary(
      content,
      new Set<string>(factLedger.map((fact) => String(fact.id))),
    );
    if (!parsed) {
      await progress?.('AI 返回内容未通过事实引用校验，使用本地发布摘要。');
      warnings.push('AI 返回内容不符合事实引用格式，使用本地发布摘要。');
      return undefined;
    }
    await progress?.('AI 摘要已返回并通过事实引用校验。');
    return parsed;
  }

  private renderMarkdown(options: {
    repository: string;
    previousTag?: string;
    currentTag: string;
    previousSha?: string;
    currentSha: string;
    facts: ReleaseFacts;
    summary?: AiReleaseSummary;
  }): string {
    const previousTag = options.previousTag ?? 'initial';
    const environmentSql = options.facts.environment.configurationSql;
    const environmentContent =
      environmentSql !== undefined
        ? [
            '',
            '### env → sys_config',
            ...(environmentSql
              ? renderCodeFence(environmentSql, 'sql')
              : ['本次没有可写入 sys_config 的新增或变更 SQL。']),
          ]
        : [
            ...renderEnvironmentChanges(options.facts.environment.diff),
            ...renderSummary(options.summary?.environmentNotes ?? []),
          ];
    const lines = [
      `# ${escapeMarkdown(previousTag)}-${escapeMarkdown(options.currentTag)}`,
      '',
      '## 各服务版本对应关系',
      `- ${escapeMarkdown(options.repository)}：${escapeMarkdown(options.currentTag)}`,
      '',
      '## 各服务迁移SQL',
      ...renderCodeFence(options.facts.database.content, 'sql'),
      ...renderSummary(options.summary?.databaseNotes ?? []),
      '',
      '## 各服务迁移环境变量',
      ...environmentContent,
      '',
      '## 更新内容(测试人员)',
      ...renderSummary(options.summary?.summary ?? localCommitSummary(options.facts.commits), true),
    ];
    return `${lines.join('\n')}\n`;
  }

  private normalizeInput(_input: ReleaseDocsInput): ReleaseDocsInput {
    return {};
  }
}

function toUpdateLogFilePart(value: string): string {
  const normalized = value
    .replace(/^refs\/tags\//, '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .slice(0, 128);
  return normalized || 'release';
}

function updateLogPathKey(path: string): string {
  return sha256(path).slice(0, 12);
}

function buildUpdateLogCommitSubject(previousTag: string, currentTag: string): string {
  return `docs: update log ${previousTag.slice(0, 64)} -> ${currentTag.slice(0, 64)}`;
}

function buildUpdateLogCommitMessage(options: {
  subject: string;
  pathKey: string;
  releaseKey: string;
  runId: string;
}): string {
  return `${options.subject} [NestCloud-RA:UpdateLog:v1:${options.pathKey}:${options.releaseKey}:${options.runId}]`;
}

function identifyUpdateLogCommit(options: {
  message: string;
  path: string;
  legacyMessage: string;
  writeSubject: string;
  releaseKey: string;
}): UpdateLogCommitIdentity | undefined {
  const pathKey = updateLogPathKey(options.path);
  const writeMatch = options.message.match(
    /^(.+) \[NestCloud-RA:UpdateLog:v1:([a-f0-9]{12}):([a-f0-9]{16}):([a-f0-9]{16})\]$/,
  );
  if (
    writeMatch?.[1] === options.writeSubject &&
    writeMatch[2] === pathKey &&
    writeMatch[3] === options.releaseKey
  ) {
    return { kind: 'write', runId: writeMatch[4] };
  }

  if (options.message.trim() === options.legacyMessage) return { kind: 'legacy-write' };
  return undefined;
}

function assertSingleFileUpdateLogCommit(details: GitHubCommitDetails, path: string): void {
  if (
    details.parents.length !== 1 ||
    details.files.length !== 1 ||
    details.files[0].path !== path
  ) {
    throw new ProjectException('update-log 提交包含其它文件或非单父提交，拒绝重写历史。', 409);
  }
}

function assertPublishedUpdateLogCommit(details: GitHubCommitDetails, path: string): void {
  assertSingleFileUpdateLogCommit(details, path);
  if (
    (details.files[0].status !== 'added' && details.files[0].status !== 'modified') ||
    !details.files[0].sha
  ) {
    throw new ProjectException('update-log 原提交不是可替换的文件写入，拒绝重写历史。', 409);
  }
}

function buildFactLedger(facts: ReleaseFacts): Array<Record<string, unknown>> {
  const commits: Array<Record<string, unknown>> = facts.commits.map((commit) => ({
    id: `commit:${commit.sha}`,
    type: 'commit',
    sha: commit.sha,
    author: commit.author,
    date: commit.date,
    subject: commit.message.split(/\r?\n/, 1)[0].slice(0, 512),
    isMerge: commit.isMerge === true,
  }));
  commits.push({
    id: 'env:summary',
    type: 'environment',
    changedKeys: facts.environment.changedKeys,
    filePath: facts.environment.filePath,
  });
  for (const entry of [
    ...facts.environment.diff.added,
    ...facts.environment.diff.removed,
    ...facts.environment.diff.changed,
  ]) {
    commits.push({
      id: `env:${entry.status}:${entry.key}`,
      type: 'environment-change',
      key: entry.key,
      status: entry.status,
      beforeValue: entry.beforeValue,
      afterValue: entry.afterValue,
      sensitive: entry.sensitive,
    });
  }
  commits.push({
    id: 'sql:summary',
    type: 'database',
    recordCount: facts.database.recordCount,
    sourceChecksum: facts.database.sourceChecksum,
    path: facts.database.path,
    content: facts.database.content.slice(0, MAX_AI_SQL_CHARACTERS),
    contentTruncated: facts.database.content.length > MAX_AI_SQL_CHARACTERS,
  });
  return commits;
}

function parseAiSummary(value: string, factIds: Set<string>): AiReleaseSummary | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || Array.isArray(parsed)) return undefined;
    const result: AiReleaseSummary = {};
    for (const key of ['summary', 'environmentNotes', 'databaseNotes'] as const) {
      const raw = parsed[key];
      if (raw === undefined) continue;
      if (!Array.isArray(raw)) return undefined;
      const items = raw.slice(0, MAX_SUMMARY_ITEMS).map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('shape');
        const candidate = item as { text?: unknown; factRefs?: unknown };
        if (
          typeof candidate.text !== 'string' ||
          !candidate.text.trim() ||
          !Array.isArray(candidate.factRefs) ||
          candidate.factRefs.length === 0 ||
          !candidate.factRefs.every((ref) => typeof ref === 'string' && factIds.has(ref))
        ) {
          throw new Error('fact reference');
        }
        return {
          text: candidate.text.trim().slice(0, 512),
          factRefs: candidate.factRefs as string[],
        };
      });
      result[key] = items;
    }
    return result;
  } catch {
    return undefined;
  }
}

function localCommitSummary(commits: GitHubCommitSummary[]): FactSummary[] {
  return commits
    .filter((commit) => !commit.isMerge)
    .slice(0, MAX_SUMMARY_ITEMS)
    .map((commit) => ({
      text: cleanCommitSubject(commit.message),
      factRefs: [`commit:${commit.sha}`],
    }))
    .filter((item) => item.text.length > 0);
}

function cleanCommitSubject(message: string): string {
  return message
    .split(/\r?\n/, 1)[0]
    .replace(
      /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?[:：]\s*/i,
      '',
    )
    .replace(/[ -]/g, ' ')
    .trim()
    .slice(0, 512);
}

function renderEnvironmentChanges(diff: EnvDiffResult): string[] {
  const sections = [
    {
      title: '新增',
      language: 'dotenv',
      content: diff.added.length
        ? diff.added.map((entry) => `${entry.key}=${entry.afterValue}`).join('\n')
        : '无新增环境变量。',
    },
    {
      title: '减少',
      language: 'dotenv',
      content: diff.removed.length
        ? diff.removed.map((entry) => `${entry.key}=${entry.beforeValue}`).join('\n')
        : '无减少环境变量。',
    },
    {
      title: '修改',
      language: 'diff',
      content: diff.changed.length
        ? diff.changed
            .flatMap((entry) => [
              `- ${entry.key}=${entry.beforeValue}`,
              `+ ${entry.key}=${entry.afterValue}`,
            ])
            .join('\n')
        : '无修改环境变量。',
    },
  ];
  return sections.flatMap((section) => [
    '',
    `### ${section.title}`,
    ...renderCodeFence(section.content, section.language),
  ]);
}

function renderCodeFence(content: string, language: string): string[] {
  const fence = content.includes('```') ? '````' : '```';
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return [`${fence}${language}`, normalized, fence];
}

function renderSummary(items: FactSummary[], encodeForwardSlash = false): string[] {
  return items.length > 0
    ? items.map((item) => `- ${escapeMarkdown(item.text, encodeForwardSlash)}`)
    : ['- 无新增事项。'];
}

function escapeMarkdown(value: string, encodeForwardSlash = false): string {
  const normalized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\r?\n/g, ' ')
    .trim();
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\\': '&#92;',
    '`': '&#96;',
    '*': '&#42;',
    _: '&#95;',
    '[': '&#91;',
    ']': '&#93;',
    '~': '&#126;',
  };
  if (encodeForwardSlash) entities['/'] = '&#47;';
  return [...normalized]
    .map((character) => entities[character] ?? character)
    .join('')
    .trim();
}
