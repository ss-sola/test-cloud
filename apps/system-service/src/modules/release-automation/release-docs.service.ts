import { Injectable } from '@nestjs/common';
import { OpenAiCompatibleClientService } from '../../client/ai/openai-compatible-client.service';
import { GitHubApiException, GitHubReleaseClientService } from './github-release-client.service';
import { diffEnv } from './env-diff.util';
import type { ReleaseAutomationConfig } from './release-automation.config';
import { ReleaseAutomationService } from './release-automation.service';
import { sha256, stableStringify } from './release-automation.security';
import type {
  GitHubCommitSummary,
  ReleaseAiConfig,
  ReleaseDocsInput,
  ReleaseDocsResult,
  ReleaseRuntimeConfig,
  ReleaseUnit,
} from './release-automation.types';

interface ReleaseDocsOptions {
  repository: string;
  releaseUnit: ReleaseUnit;
  config: ReleaseAutomationConfig;
  runtime?: ReleaseRuntimeConfig;
  input: ReleaseDocsInput;
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
  };
  database: {
    recordCount: number;
    sourceChecksum: string;
  };
}

const DEFAULT_AI_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PROMPT_CHARACTERS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 50_000;
const DEFAULT_MAX_COMMITS = 100;
const MAX_SUMMARY_ITEMS = 5;

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
    const tagRange = await this.resolveTagRange(options.repository, currentTag, options.config);
    const facts = await this.collectFacts({
      repository: options.repository,
      releaseUnit: options.releaseUnit,
      config: options.config,
      input,
      previousTag: tagRange.previous?.name,
      currentTag: tagRange.current.name,
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
      environment: facts.environment,
      database: facts.database,
    };
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
  }): Promise<ReleaseFacts> {
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
    const environment = await this.collectEnvironmentFacts({
      repository: options.repository,
      config: options.config,
      previousTag: options.previousTag,
      currentTag: options.currentTag,
    });
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
  ): Promise<AiReleaseSummary | undefined> {
    if (!ai) {
      warnings.push('未配置 AI，使用本地发布摘要。');
      return undefined;
    }
    if (!ai.baseUrl || !ai.apiKey || !ai.model) {
      throw new Error('AI 配置必须同时提供 baseUrl、apiKey 和 model。');
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
    const content = await this.aiClient.request({
      ai,
      prompt,
      systemMessage:
        '你只输出可解析的 JSON 对象，字段为 summary、environmentNotes、databaseNotes，数组元素包含 text 和 factRefs。',
      timeoutMs: limits.aiTimeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
      maxPromptCharacters: limits.maxPromptCharacters ?? DEFAULT_MAX_PROMPT_CHARACTERS,
      maxResponseCharacters: limits.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS,
    });
    if (!content) {
      warnings.push('AI 请求失败或返回为空，使用本地发布摘要。');
      return undefined;
    }
    const parsed = parseAiSummary(
      content,
      new Set<string>(factLedger.map((fact) => String(fact.id))),
    );
    if (!parsed) {
      warnings.push('AI 返回内容不符合事实引用格式，使用本地发布摘要。');
      return undefined;
    }
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
    const lines = [
      '# 发布说明',
      '',
      `- 仓库：${escapeMarkdown(options.repository)}`,
      `- Tag 范围：${escapeMarkdown(options.previousTag ?? '首次发布')} → ${escapeMarkdown(options.currentTag)}`,
      `- SHA 范围：${escapeMarkdown(options.previousSha ?? '无上一 tag')} → ${escapeMarkdown(options.currentSha)}`,
      `- 提交数：${options.facts.commits.length}（合并提交 ${options.facts.commits.filter((commit) => commit.isMerge).length}）`,
      '',
      '## 变更摘要',
      ...renderSummary(options.summary?.summary ?? localCommitSummary(options.facts.commits)),
      '',
      '## 环境配置',
      `- 文件：${escapeMarkdown(options.facts.environment.filePath)}`,
      `- 变更项：${options.facts.environment.changedKeys}`,
      `- 变更前 checksum：${options.facts.environment.beforeChecksum}`,
      `- 变更后 checksum：${options.facts.environment.afterChecksum}`,
      ...renderSummary(options.summary?.environmentNotes ?? []),
      '',
      '## 数据库变更事实',
      `- 记录数：${options.facts.database.recordCount}`,
      `- 源文件 checksum：${options.facts.database.sourceChecksum}`,
      ...renderSummary(options.summary?.databaseNotes ?? []),
    ];
    return `${lines.join('\n')}\n`;
  }

  private normalizeInput(_input: ReleaseDocsInput): ReleaseDocsInput {
    return {};
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
  commits.push({
    id: 'sql:summary',
    type: 'database',
    recordCount: facts.database.recordCount,
    sourceChecksum: facts.database.sourceChecksum,
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
