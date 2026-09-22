import { Injectable } from '@nestjs/common';
import { OpenAiCompatibleClientService } from '../../client/ai/openai-compatible-client.service';
import { GitHubReleaseClientService } from './github-release-client.service';
import { diffEnv } from './env-diff.util';
import type { ReleaseAutomationConfig } from './release-automation.config';
import { ReleaseAutomationService } from './release-automation.service';
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
  publish?: {
    mode: ReleaseMode;
    sideEffectGate: string;
  };
  progress?: (message: string) => Promise<void>;
}

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
    const markdown = this.renderMarkdown({
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
      publication = await this.publishUpdateLog({
        repository: options.repository,
        branch: options.releaseUnit.targetBranch,
        previousTag: tagRange.previous?.name,
        currentTag: tagRange.current.name,
        markdown,
        mode: options.publish.mode,
        sideEffectGate: options.publish.sideEffectGate,
        config: options.config,
      });
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

  private async publishUpdateLog(options: {
    repository: string;
    branch: string;
    previousTag?: string;
    currentTag: string;
    markdown: string;
    mode: ReleaseMode;
    sideEffectGate: string;
    config: ReleaseAutomationConfig;
  }): Promise<ReleaseDocsPublication> {
    const path = `update-log/${toUpdateLogFilePart(options.previousTag ?? 'initial')}-${toUpdateLogFilePart(options.currentTag)}.md`;
    if (options.mode === 'dry-run') {
      return { status: 'planned', path, branch: options.branch };
    }
    const result = await this.github.putContents(
      {
        repository: options.repository,
        path,
        branch: options.branch,
        content: options.markdown,
        commitMessage: `docs: update log ${toUpdateLogFilePart(options.previousTag ?? 'initial')} -> ${toUpdateLogFilePart(options.currentTag)}`,
        mode: options.mode,
        sideEffectGate: options.sideEffectGate,
      },
      options.config,
    );
    return result;
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
    await options.progress?.('正在从 GitHub 读取 modify-log.sql。');
    const preparation = await this.releaseService.prepareModifyLog({
      releaseUnit: options.releaseUnit,
      mode: 'dry-run',
      config: options.config,
    });
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
    return {
      filePath,
      changedKeys: diff.added.length + diff.removed.length + diff.changed.length,
      beforeChecksum: diff.beforeChecksum,
      afterChecksum: diff.afterChecksum,
      diff,
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
    const environmentChanges = [
      ...options.facts.environment.diff.added,
      ...options.facts.environment.diff.removed,
      ...options.facts.environment.diff.changed,
    ];
    const previousTag = options.previousTag ?? 'initial';
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
      ...renderEnvironmentCodeBlock(environmentChanges),
      ...renderSummary(options.summary?.environmentNotes ?? []),
      '',
      '## 更新内容(测试人员)',
      ...renderSummary(options.summary?.summary ?? localCommitSummary(options.facts.commits)),
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

function renderEnvironmentCodeBlock(entries: EnvDiffResult['added']): string[] {
  const lines = entries.length
    ? entries.map(
        (entry) =>
          `# ${entry.status} ${entry.key}: ${entry.beforeValue || '∅'} -> ${entry.afterValue || '∅'}`,
      )
    : ['# 无环境变量差异'];
  return ['```bash', ...lines, '```'];
}

function renderCodeFence(content: string, language: string): string[] {
  const fence = content.includes('```') ? '````' : '```';
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return [`${fence}${language}`, normalized, fence];
}

function renderSummary(items: FactSummary[]): string[] {
  return items.length > 0
    ? items.map((item) => `- ${escapeMarkdown(item.text)}`)
    : ['- 无新增事项。'];
}

function escapeMarkdown(value: string): string {
  const normalized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\r?\n/g, ' ')
    .trim();
  const markdownCharacters = '\\`*_{}[]()#+.!|>';
  return [...normalized]
    .map((character) => (markdownCharacters.includes(character) ? `\\${character}` : character))
    .join('')
    .trim();
}
