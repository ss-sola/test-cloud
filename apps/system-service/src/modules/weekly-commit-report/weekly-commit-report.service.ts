import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import {
  getConfig,
  ParamsErrorException,
  ProjectException,
} from '@nest-cloud/common';
import {
  DEFAULT_WEEKLY_REPORT_PROJECTS,
  WeeklyReportConfigKeys,
} from './weekly-report.constants';
import type {
  DailyReportSection,
  GenerateWeeklyReportInput,
  GitLogEntry,
  WeekWindow,
  WeeklyReportLimits,
  WeeklyReportProjectConfig,
  WeeklyReportProjectResult,
  WeeklyReportResult,
} from './weekly-report.types';

const execFileAsync = promisify(execFile);

const GIT_RECORD_SEPARATOR = '';
const GIT_FIELD_SEPARATOR = '';
const MAX_DAILY_BULLETS = 5;
const MIN_DAILY_BULLETS = 2;
const MAX_REPOSITORY_URL_LENGTH = 2048;
const MAX_AI_RESPONSE_CHARACTERS = 50_000;
const NO_COMMIT_BULLET = '无提交。';
const NO_NEW_BULLET = '无新增事项。';
const CONVENTIONAL_COMMIT_PREFIX =
  /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?[:：]\s*/i;

interface SummaryContext {
  date?: string;
  person: string;
  repoLabel: string;
  weekStart?: string;
  weekEnd?: string;
  priorBullets?: string[];
}

interface SummaryResult {
  bullets: string[];
  degraded: boolean;
}

interface MaterializedRepository {
  localRepoPath: string;
  temporary: boolean;
}

interface ProjectWorkResult {
  config: WeeklyReportProjectConfig;
  repoLabel: string;
  logs: GitLogEntry[];
  bullets: string[];
  degraded: boolean;
}

@Injectable()
export class WeeklyCommitReportService {
  private readonly logger = new Logger(WeeklyCommitReportService.name);

  async generate(input: GenerateWeeklyReportInput): Promise<WeeklyReportResult> {
    const configs = this.resolveConfigs(input.configs);
    const now = new Date();
    const window = input.period === 'this-week'
      ? this.getThisWeekWindow(now)
      : this.getLastWeekWindow(now);

    if (input.period === 'this-week') {
      return this.generateThisWeek(configs, window);
    }

    return this.generateLastWeek(configs, window);
  }

  getLastWeekWindow(now: Date = new Date()): WeekWindow {
    const currentWeekStart = this.getCurrentWeekStart(now);
    const lastWeekStart = new Date(currentWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    return {
      start: lastWeekStart,
      end: currentWeekStart,
      dayKeys: this.buildDayKeys(lastWeekStart, 7),
    };
  }

  getThisWeekWindow(now: Date = new Date()): WeekWindow {
    const currentWeekStart = this.getCurrentWeekStart(now);
    const currentDay = this.startOfLocalDay(now);
    const dayCount = Math.max(
      1,
      Math.floor((currentDay.getTime() - currentWeekStart.getTime()) / 86_400_000) + 1,
    );

    return {
      start: currentWeekStart,
      end: new Date(now),
      dayKeys: this.buildDayKeys(currentWeekStart, dayCount),
    };
  }

  buildGitLogArgs(options: {
    repoPath: string;
    ref: string;
    since: Date;
    until: Date;
    person: string;
  }): string[] {
    return [
      '-C',
      options.repoPath,
      'log',
      options.ref,
      '--no-merges',
      `--since=${options.since.toISOString()}`,
      `--until=${options.until.toISOString()}`,
      `--author=${this.escapeGitAuthorPattern(options.person)}`,
      '--date=iso-strict',
      `--pretty=format:%H${GIT_FIELD_SEPARATOR}%an${GIT_FIELD_SEPARATOR}%ad${GIT_FIELD_SEPARATOR}%s${GIT_FIELD_SEPARATOR}%b${GIT_RECORD_SEPARATOR}`,
      '-n',
      String(this.getLimits().maxCommitsPerRepository),
    ];
  }

  parseGitLogOutput(rawOutput: string): GitLogEntry[] {
    if (!rawOutput) return [];

    return rawOutput
      .split(GIT_RECORD_SEPARATOR)
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash = '', author = '', date = '', subject = '', body = ''] =
          record.split(GIT_FIELD_SEPARATOR);
        return { hash, author, date, subject, body: body.trim() };
      });
  }

  groupLogsByDay(logs: GitLogEntry[], dayKeys: string[]) {
    const bucketMap = new Map<string, GitLogEntry[]>(dayKeys.map((dayKey) => [dayKey, []]));

    for (const log of logs) {
      const dayKey = this.formatLocalDate(new Date(log.date));
      const bucket = bucketMap.get(dayKey);
      if (bucket) bucket.push(log);
    }

    return dayKeys.map((date) => ({ date, logs: bucketMap.get(date) ?? [] }));
  }

  buildLocalSummary(logs: GitLogEntry[]): string[] {
    const seen = new Set<string>();
    const items: string[] = [];
    const subjectLimit = logs.length > MAX_DAILY_BULLETS
      ? MAX_DAILY_BULLETS - 1
      : MAX_DAILY_BULLETS;

    for (const log of logs) {
      const subject = this.normalizeCommitSubject(log.subject);
      if (!subject || this.isCodeIntegrationBullet(subject)) continue;

      const key = this.canonicalizeBullet(subject);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(subject);

      if (items.length === subjectLimit) break;
    }

    if (logs.length > items.length && items.length > 0) {
      items.push(`其余 ${logs.length - items.length} 条提交以细节调整和配套修改为主。`);
    }

    return items.length > 0 ? items : [NO_NEW_BULLET];
  }

  normalizeBulletLines(content: string): string[] {
    return this.dedupeBullets(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !/^#+\s/.test(line)),
      new Set<string>(),
      MAX_DAILY_BULLETS,
    );
  }

  distributeBulletsAcrossDays(bullets: string[], dayKeys: string[]): DailyReportSection[] {
    const items = this.dedupeBullets(bullets, new Set<string>());
    if (items.length === 0) {
      return dayKeys.map((date) => ({ date, logs: [], bullets: [NO_COMMIT_BULLET] }));
    }

    const maxItems = dayKeys.length * MAX_DAILY_BULLETS;
    const displayItems = items.length > maxItems
      ? [
          ...items.slice(0, Math.max(0, maxItems - 1)),
          `其余 ${items.length - Math.max(0, maxItems - 1)} 条工作未展开。`,
        ]
      : items;
    const baseCount = Math.floor(displayItems.length / dayKeys.length);
    const remainder = displayItems.length % dayKeys.length;
    const sections: DailyReportSection[] = [];
    let offset = 0;

    for (let index = 0; index < dayKeys.length; index += 1) {
      const itemCount = baseCount + (index < remainder ? 1 : 0);
      sections.push({
        date: dayKeys[index],
        logs: [],
        bullets: itemCount > 0
          ? displayItems.slice(offset, offset + itemCount)
          : [NO_NEW_BULLET],
      });
      offset += itemCount;
    }

    return sections;
  }

  renderLastWeekReport(options: {
    person: string;
    weekStart: string;
    weekEnd: string;
    projects: WeeklyReportProjectConfig[];
    sections: DailyReportSection[];
  }): string {
    const header = [
      `# ${options.person} 上周任务日志`,
      '',
      `- Person: ${options.person}`,
      `- Week: ${options.weekStart} ~ ${options.weekEnd}`,
      `- Projects: ${options.projects.length}`,
      `- Sources: ${options.projects.map((project) => `${this.getRepoLabel(project.repo)}@${project.branch ?? 'HEAD'}`).join(', ')}`,
    ].join('\n');

    const sectionBlocks = options.sections.map((section) => [
      `## ${this.formatDateWithWeekday(section.date)}`,
      '',
      ...this.normalizeRenderedItems(section.bullets).map((item, index) => `${index + 1}. ${item}`),
    ].join('\n'));

    return `${[header, ...sectionBlocks].join('\n\n')}\n`;
  }

  renderThisWeekReport(options: {
    person: string;
    weekStart: string;
    weekEnd: string;
    projects: Array<WeeklyReportProjectResult & { bullets: string[] }>;
  }): string {
    const header = [
      `# ${options.person} 本周项目提交汇总`,
      '',
      `- Person: ${options.person}`,
      `- Week: ${options.weekStart} ~ ${options.weekEnd}`,
      `- Projects: ${options.projects.length}`,
    ].join('\n');

    const summaryItems = this.normalizeRenderedItems(
      this.dedupeBullets(options.projects.flatMap((project) => project.bullets), new Set<string>()),
    );
    const summaryBlock = [
      '## 本周摘要（去重）',
      '',
      ...summaryItems.map((item, index) => `${index + 1}. ${item}`),
    ].join('\n');

    const projectBlocks = options.projects.map((project) => [
      `## ${project.repoLabel}`,
      '',
      `- Repo: ${project.repo}`,
      `- Person: ${project.person}`,
      `- Branch: ${project.branch}`,
      `- Commits: ${project.commitCount}`,
      '',
      ...this.normalizeRenderedItems(project.bullets).map((item, index) => `${index + 1}. ${item}`),
    ].join('\n'));

    return `${[header, summaryBlock, ...projectBlocks].join('\n\n')}\n`;
  }

  private async generateThisWeek(
    configs: WeeklyReportProjectConfig[],
    window: WeekWindow,
  ): Promise<WeeklyReportResult> {
    const projectWork: ProjectWorkResult[] = [];
    for (const config of configs) {
      const repoLabel = this.getRepoLabel(config.repo);
      const logs = await this.collectGitLogs(config, window);
      const summary = logs.length === 0
        ? { bullets: [NO_COMMIT_BULLET], degraded: false }
        : await this.summarizeProject(logs, {
            person: config.person,
            repoLabel,
            weekStart: window.dayKeys[0],
            weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
          });
      projectWork.push({
        config,
        repoLabel,
        logs,
        bullets: summary.bullets,
        degraded: summary.degraded,
      });
    }

    const projects = projectWork.map((work) => ({
      repo: work.config.repo,
      repoLabel: work.repoLabel,
      person: work.config.person,
      branch: work.config.branch ?? 'HEAD',
      commitCount: work.logs.length,
      bullets: work.bullets,
    }));
    const markdown = this.limitOutput(this.renderThisWeekReport({
      person: this.getPersonLabel(projects),
      weekStart: window.dayKeys[0],
      weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
      projects,
    }));

    return {
      period: 'this-week',
      weekStart: window.dayKeys[0],
      weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
      markdown,
      projects,
      commitCount: projects.reduce((total, project) => total + project.commitCount, 0),
      degraded: projectWork.some((work) => work.degraded),
    };
  }

  private async generateLastWeek(
    configs: WeeklyReportProjectConfig[],
    window: WeekWindow,
  ): Promise<WeeklyReportResult> {
    const mergedBullets: string[] = [];
    const projectResults: WeeklyReportProjectResult[] = [];
    let degraded = false;

    for (const config of configs) {
      const repoLabel = this.getRepoLabel(config.repo);
      const logs = await this.collectGitLogs(config, window);
      const summary = await this.buildDailySections(logs, window.dayKeys, {
        person: config.person,
        repoLabel,
      });
      degraded ||= summary.degraded;
      mergedBullets.push(...summary.sections.flatMap((section) => section.bullets));
      projectResults.push({
        repo: config.repo,
        repoLabel,
        person: config.person,
        branch: config.branch ?? 'HEAD',
        commitCount: logs.length,
        bullets: summary.sections.flatMap((section) => section.bullets),
      });
    }

    const sections = this.distributeBulletsAcrossDays(
      this.dedupeBullets(mergedBullets, new Set<string>()),
      window.dayKeys.slice(0, 5),
    );
    const markdown = this.limitOutput(this.renderLastWeekReport({
      person: this.getPersonLabel(projectResults),
      weekStart: window.dayKeys[0],
      weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
      projects: configs,
      sections,
    }));

    return {
      period: 'last-week',
      weekStart: window.dayKeys[0],
      weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
      markdown,
      projects: projectResults,
      commitCount: projectResults.reduce((total, project) => total + project.commitCount, 0),
      degraded,
    };
  }

  private async buildDailySections(
    logs: GitLogEntry[],
    dayKeys: string[],
    context: Pick<SummaryContext, 'person' | 'repoLabel'>,
  ): Promise<{ sections: DailyReportSection[]; degraded: boolean }> {
    const sections: DailyReportSection[] = [];
    const seenBulletKeys = new Set<string>();
    let degraded = false;

    for (const group of this.groupLogsByDay(logs, dayKeys)) {
      if (group.logs.length === 0) {
        sections.push({ date: group.date, logs: [], bullets: [NO_COMMIT_BULLET] });
        continue;
      }

      const summary = await this.summarizeDaily(group.logs, {
        date: group.date,
        person: context.person,
        repoLabel: context.repoLabel,
        priorBullets: sections.flatMap((section) => section.bullets),
      });
      degraded ||= summary.degraded;
      const bullets = this.dedupeBullets(summary.bullets, seenBulletKeys);
      sections.push({
        date: group.date,
        logs: group.logs,
        bullets: bullets.length > 0 ? bullets : [NO_NEW_BULLET],
      });
    }

    return { sections, degraded };
  }

  private async collectGitLogs(
    config: WeeklyReportProjectConfig,
    window: WeekWindow,
  ): Promise<GitLogEntry[]> {
    let repository: MaterializedRepository | undefined;
    try {
      repository = await this.materializeRepository(config.repo);
      const ref = await this.resolveBranchRef(repository.localRepoPath, config.branch);
      const rawOutput = await this.runGit(
        this.buildGitLogArgs({
          repoPath: repository.localRepoPath,
          ref,
          since: window.start,
          until: window.end,
          person: config.person,
        }),
        repository.localRepoPath,
      );
      return this.parseGitLogOutput(rawOutput);
    } catch (error) {
      this.logger.warn(`读取周报仓库失败：${this.getRepoLabel(config.repo)}`);
      if (error instanceof ProjectException) throw error;
      throw new ProjectException(
        `无法读取仓库 ${this.getRepoLabel(config.repo)} 的提交，请检查仓库、分支和 Git 配置。`,
        502,
      );
    } finally {
      if (repository?.temporary) {
        await rm(repository.localRepoPath, { recursive: true, force: true }).catch((error: unknown) => {
          this.logger.warn(`清理周报临时仓库失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  private async materializeRepository(repo: string): Promise<MaterializedRepository> {
    if (!this.isRemoteRepository(repo)) {
      return { localRepoPath: await this.resolveLocalRepository(repo), temporary: false };
    }

    const temporaryPath = await mkdtemp(join(tmpdir(), 'nestcloud-weekly-report-'));
    try {
      await this.runGit(
        ['clone', '--bare', '--filter=blob:none', repo, temporaryPath],
        undefined,
      );
      return { localRepoPath: temporaryPath, temporary: true };
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true }).catch((cleanupError: unknown) => {
        this.logger.warn(`清理周报临时仓库失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      });
      throw error;
    }
  }

  private async resolveBranchRef(repoPath: string, branch?: string): Promise<string> {
    if (!branch) return 'HEAD';

    for (const candidate of [branch, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      try {
        await this.runGit(['-C', repoPath, 'rev-parse', '--verify', candidate], repoPath);
        return candidate;
      } catch {
        // Try the next fully-qualified ref.
      }
    }

    return branch;
  }

  private async runGit(args: string[], cwd?: string): Promise<string> {
    const limits = this.getLimits();
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: limits.commandTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      return String(result.stdout).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out|ETIMEDOUT|killed/i.test(message)) {
        throw new ProjectException('Git 操作超时，请缩小仓库范围或稍后重试。', 504);
      }
      throw error;
    }
  }

  private async summarizeDaily(logs: GitLogEntry[], context: SummaryContext): Promise<SummaryResult> {
    const prompt = this.buildDailySummaryPrompt(logs, context);
    const ai = this.getAiConfig();
    const aiBullets = await this.requestAiSummary(ai, prompt, '研发日报助手');
    if (aiBullets) return { bullets: aiBullets, degraded: false };
    return { bullets: this.buildLocalSummary(logs), degraded: true };
  }

  private async summarizeProject(logs: GitLogEntry[], context: SummaryContext): Promise<SummaryResult> {
    const prompt = this.buildProjectSummaryPrompt(logs, context);
    const ai = this.getAiConfig();
    const aiBullets = await this.requestAiSummary(ai, prompt, '研发周报助手');
    if (aiBullets) return { bullets: aiBullets, degraded: false };
    return { bullets: this.buildLocalSummary(logs), degraded: true };
  }

  private async requestAiSummary(
    ai: { baseUrl: string; apiKey: string; model: string },
    prompt: string,
    role: string,
  ): Promise<string[] | undefined> {
    if (!ai.baseUrl || !ai.apiKey || !ai.model) return undefined;
    if (prompt.length > this.getLimits().maxPromptCharacters) return undefined;

    let baseUrl: URL;
    try {
      baseUrl = new URL(ai.baseUrl);
      if (!['http:', 'https:'].includes(baseUrl.protocol)) return undefined;
    } catch {
      this.logger.warn('周报摘要服务地址无效，使用本地摘要。');
      return undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.getLimits().aiTimeoutMs);
    try {
      const response = await fetch(`${baseUrl.toString().replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ai.apiKey}`,
        },
        body: JSON.stringify({
          model: ai.model,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: `你是一名${role}。请只输出简洁、准确、适合直接汇报的中文有序列表。每行只输出一条，使用 1. 2. 这样的编号格式，不要输出标题、段落、commit hash 或虚构事实。只保留实际开发、修复、配置、测试或发布成果。`,
            },
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (!response.ok || contentLength > MAX_AI_RESPONSE_CHARACTERS) return undefined;
      const raw = await response.text();
      if (raw.length > MAX_AI_RESPONSE_CHARACTERS) return undefined;
      const payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
      const bullets = this.normalizeBulletLines(content);
      return bullets.length > 0 ? bullets : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildDailySummaryPrompt(logs: GitLogEntry[], context: SummaryContext): string {
    const commitLines = logs
      .slice(0, this.getLimits().maxPromptCommits)
      .map((log) => {
        const timeLabel = log.date.slice(11, 16);
        const subject = this.normalizeCommitSubject(log.subject);
        const firstBodyLine = this.firstMeaningfulBodyLine(log.body);
        return firstBodyLine
          ? `- ${timeLabel} ${log.author}: ${subject} | ${firstBodyLine}`
          : `- ${timeLabel} ${log.author}: ${subject}`;
      })
      .join('\n');

    return [
      `请基于以下提交记录，生成 ${context.person} 在 ${context.repoLabel} 的 ${context.date} 日报。`,
      `1. 只输出 ${MIN_DAILY_BULLETS}-${MAX_DAILY_BULLETS} 条独立工作成果，每行一条；如果有效成果不足，不要编造或重复。`,
      '2. 同一任务的实施、修复和配套提交可以概括为一条，但不同工作成果不要合并成空泛描述。',
      '3. 不要输出分支合并、代码合入、merge、rebase、cherry-pick、PR/MR 同步或解决合并冲突等纯代码集成事项。',
      '4. 不要输出标题、commit hash 或记录中没有的事实。',
      ...(context.priorBullets?.length
        ? [
            '5. 以下事项已在本周其他日期出现，请不要再次输出相同或换一种说法重复它们：',
            ...context.priorBullets
              .filter((bullet) => !this.isPlaceholderBullet(bullet))
              .map((bullet) => `- ${bullet}`),
          ]
        : []),
      '',
      `共 ${logs.length} 条提交：`,
      commitLines,
    ].join('\n');
  }

  private buildProjectSummaryPrompt(logs: GitLogEntry[], context: SummaryContext): string {
    const commitLines = logs
      .slice(0, this.getLimits().maxPromptCommits)
      .map((log) => {
        const dateLabel = this.formatLocalDate(new Date(log.date));
        const timeLabel = log.date.slice(11, 16);
        const subject = this.normalizeCommitSubject(log.subject);
        const firstBodyLine = this.firstMeaningfulBodyLine(log.body);
        return firstBodyLine
          ? `- ${dateLabel} ${timeLabel} ${log.author}: ${subject} | ${firstBodyLine}`
          : `- ${dateLabel} ${timeLabel} ${log.author}: ${subject}`;
      })
      .join('\n');

    return [
      `请基于以下提交记录，生成 ${context.person} 本周在 ${context.repoLabel} 项目的工作汇总。`,
      `1. 只输出 ${MIN_DAILY_BULLETS}-${MAX_DAILY_BULLETS} 条独立工作成果，每行一条；如果有效成果不足，不要编造或重复。`,
      '2. 同一任务的实施、修复和配套提交可以概括为一条，但不同工作成果不要合并成空泛描述。',
      '3. 不要按天拆分，不要输出日期、小标题、commit hash 或记录中没有的事实。',
      '',
      `统计区间：${context.weekStart} ~ ${context.weekEnd}`,
      `共 ${logs.length} 条提交：`,
      commitLines,
    ].join('\n');
  }

  private resolveConfigs(configs?: WeeklyReportProjectConfig[]): WeeklyReportProjectConfig[] {
    const source = configs?.length ? configs : this.getConfiguredProjects();
    const limits = this.getLimits();
    if (source.length === 0 || source.length > limits.maxProjects) {
      throw new ParamsErrorException(`周报项目数量必须在 1 到 ${limits.maxProjects} 个之间。`);
    }

    return source.map((config) => {
      const repo = config.repo?.trim();
      const person = config.person?.trim();
      const branch = config.branch?.trim();
      if (!repo || !person) {
        throw new ParamsErrorException('周报项目必须提供仓库和提交人。');
      }
      if (repo.length > MAX_REPOSITORY_URL_LENGTH || /[ -]/.test(repo)) {
        throw new ParamsErrorException('仓库地址格式无效。');
      }
      if (/[ -]/.test(person) || (branch && /[ -]/.test(branch))) {
        throw new ParamsErrorException('周报项目字段包含不允许的控制字符。');
      }
      if (branch && (branch.length > 256 || branch.startsWith('-') || branch.includes('..') || branch.includes('@{'))) {
        throw new ParamsErrorException('分支名称格式无效。');
      }
      this.assertAllowedRepository(repo);
      return { repo, person, ...(branch ? { branch } : {}) };
    });
  }

  private getConfiguredProjects(): WeeklyReportProjectConfig[] {
    const configured = getConfig<string>(WeeklyReportConfigKeys.AllowedRepositories, '', false)
      .split(',')
      .map((repo) => repo.trim())
      .filter(Boolean);
    const allowed = configured.length ? configured : DEFAULT_WEEKLY_REPORT_PROJECTS.map((project) => project.repo);
    const defaultsByRepo = new Map(DEFAULT_WEEKLY_REPORT_PROJECTS.map((project) => [this.canonicalRepo(project.repo), project]));
    return allowed.map((repo) => defaultsByRepo.get(this.canonicalRepo(repo)) ?? {
      repo,
      person: 'ljh',
      branch: undefined,
    });
  }

  private assertAllowedRepository(repo: string): void {
    if (this.isUrlLikeRepository(repo)) {
      if (!this.isRemoteRepository(repo)) {
        throw new ParamsErrorException('周报仅支持 HTTPS 仓库地址。');
      }
      this.validateRemoteRepository(repo);
      const allowed = getConfig<string>(WeeklyReportConfigKeys.AllowedRepositories, '', false)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const allowedRepos = allowed.length ? allowed : DEFAULT_WEEKLY_REPORT_PROJECTS.map((project) => project.repo);
      if (!allowedRepos.some((item) => this.canonicalRepo(item) === this.canonicalRepo(repo))) {
        throw new ParamsErrorException('仓库不在周报允许访问列表中。');
      }
      return;
    }

    if (/^git@/i.test(repo)) {
      throw new ParamsErrorException('周报不支持 SSH 仓库地址。');
    }
    this.validateLocalRepository(repo);
  }

  private validateLocalRepository(repo: string): string {
    const localRoot = resolve(
      getConfig<string>(WeeklyReportConfigKeys.AllowedLocalRoot, process.cwd(), false),
    );
    const localPath = resolve(repo);
    const normalizedRoot = this.normalizePathForComparison(localRoot);
    const normalizedPath = this.normalizePathForComparison(localPath);
    if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) {
      throw new ParamsErrorException('本地仓库不在周报允许访问目录中。');
    }
    return localPath;
  }

  private async resolveLocalRepository(repo: string): Promise<string> {
    const localPath = this.validateLocalRepository(repo);
    const localRoot = resolve(
      getConfig<string>(WeeklyReportConfigKeys.AllowedLocalRoot, process.cwd(), false),
    );
    try {
      const [resolvedRoot, resolvedPath] = await Promise.all([
        realpath(localRoot),
        realpath(localPath),
      ]);
      const normalizedRoot = this.normalizePathForComparison(resolvedRoot);
      const normalizedPath = this.normalizePathForComparison(resolvedPath);
      if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) {
        throw new ParamsErrorException('本地仓库不在周报允许访问目录中。');
      }
      return resolvedPath;
    } catch (error) {
      if (error instanceof ParamsErrorException) throw error;
      throw new ParamsErrorException('本地仓库不存在或无法访问。');
    }
  }

  private validateRemoteRepository(repo: string): void {
    try {
      const parsed = new URL(repo);
      if (
        parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash
        || (parsed.port && parsed.port !== '443')
      ) {
        throw new ParamsErrorException('仓库地址必须是无凭据、无参数的标准 HTTPS 地址。');
      }
    } catch (error) {
      if (error instanceof ParamsErrorException) throw error;
      throw new ParamsErrorException('仓库地址格式无效。');
    }
  }

  private isUrlLikeRepository(repo: string): boolean {
    return /^[a-z][a-z\d+.-]*:\/\//i.test(repo);
  }

  private isRemoteRepository(repo: string): boolean {
    try {
      return new URL(repo).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private getAiConfig() {
    return {
      baseUrl: getConfig<string>(WeeklyReportConfigKeys.AiBaseUrl, '', false).trim(),
      apiKey: getConfig<string>(WeeklyReportConfigKeys.AiApiKey, '', false).trim(),
      model: getConfig<string>(WeeklyReportConfigKeys.AiModel, '', false).trim(),
    };
  }

  private getLimits(): WeeklyReportLimits {
    return {
      maxProjects: this.readPositiveConfig(WeeklyReportConfigKeys.MaxProjects, 10, 1, 10),
      maxCommitsPerRepository: this.readPositiveConfig(WeeklyReportConfigKeys.MaxCommits, 100, 1, 500),
      maxPromptCommits: this.readPositiveConfig(WeeklyReportConfigKeys.MaxPromptCommits, 40, 1, 100),
      maxPromptCharacters: this.readPositiveConfig(WeeklyReportConfigKeys.MaxPromptCharacters, 30_000, 1000, 100_000),
      maxOutputCharacters: this.readPositiveConfig(WeeklyReportConfigKeys.MaxOutputCharacters, 100_000, 1000, 500_000),
      commandTimeoutMs: this.readPositiveConfig(WeeklyReportConfigKeys.CommandTimeoutMs, 60_000, 1000, 300_000),
      aiTimeoutMs: this.readPositiveConfig(WeeklyReportConfigKeys.AiTimeoutMs, 30_000, 1000, 120_000),
    };
  }

  private readPositiveConfig(key: string, fallback: number, min: number, max: number): number {
    const value = getConfig<number>(key, fallback, false);
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback));
  }

  private limitOutput(content: string): string {
    const limit = this.getLimits().maxOutputCharacters;
    return content.length <= limit
      ? content
      : `${content.slice(0, limit - 32)}\n\n[报告内容已达到长度上限。]\n`;
  }

  private getRepoLabel(repo: string): string {
    const normalized = repo.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || normalized;
  }

  private getPersonLabel(projects: Array<{ person: string }>): string {
    return Array.from(new Set(projects.map((project) => project.person))).join(' / ');
  }

  private canonicalRepo(repo: string): string {
    try {
      const parsed = new URL(repo);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '');
      return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}:${port}${parsed.pathname
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '')}`;
    } catch {
      return this.normalizePathForComparison(repo).replace(/[\\/]+$/, '');
    }
  }

  private normalizePathForComparison(value: string): string {
    const normalized = resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private escapeGitAuthorPattern(person: string): string {
    return person.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private normalizeCommitSubject(subject: string): string {
    const trimmed = subject.trim();
    return trimmed.replace(CONVENTIONAL_COMMIT_PREFIX, '').trim() || trimmed;
  }

  private normalizeSummaryLine(line: string): string {
    return this.normalizeCommitSubject(line.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '').trim());
  }

  private canonicalizeBullet(bullet: string): string {
    return this.normalizeSummaryLine(bullet)
      .replace(/[。；;，,]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  private dedupeBullets(
    bullets: string[],
    seenKeys: Set<string>,
    limit = Number.POSITIVE_INFINITY,
  ): string[] {
    const result: string[] = [];
    for (const bullet of bullets) {
      const normalized = this.normalizeSummaryLine(bullet);
      if (!normalized || this.isPlaceholderBullet(normalized) || this.isCodeIntegrationBullet(normalized)) continue;
      const key = this.canonicalizeBullet(normalized);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      result.push(normalized);
      if (result.length === limit) break;
    }
    return result;
  }

  private normalizeRenderedItems(items: string[]): string[] {
    const normalized = this.dedupeBullets(items, new Set<string>(), MAX_DAILY_BULLETS);
    if (normalized.length > 0) return normalized;
    const placeholders = items.map((item) => this.normalizeSummaryLine(item));
    return placeholders.includes(NO_NEW_BULLET) ? [NO_NEW_BULLET] : [NO_COMMIT_BULLET];
  }

  private isCodeIntegrationBullet(bullet: string): boolean {
    const normalized = this.normalizeSummaryLine(bullet);
    return /^(?:(?:merge|rebase|cherry-pick)\b.*|(?:合并|合入|同步)\s*(?:(?:[\w./-]+\s*)?(?:分支|代码|主分支|PR|MR|请求))|(?:解决|处理)\s*合并冲突)/i.test(normalized);
  }

  private isPlaceholderBullet(bullet: string): boolean {
    return bullet === NO_COMMIT_BULLET || bullet === NO_NEW_BULLET;
  }

  private firstMeaningfulBodyLine(body: string): string | undefined {
    return body.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  }

  private formatDateWithWeekday(date: string): string {
    const labels = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return `${date}（${labels[new Date(`${date}T00:00:00`).getDay()]}）`;
  }

  private getCurrentWeekStart(now: Date): Date {
    const currentWeekStart = this.startOfLocalDay(now);
    const daysSinceMonday = (currentWeekStart.getDay() + 6) % 7;
    currentWeekStart.setDate(currentWeekStart.getDate() - daysSinceMonday);
    return currentWeekStart;
  }

  private buildDayKeys(start: Date, dayCount: number): string[] {
    return Array.from({ length: dayCount }, (_, index) => {
      const dayDate = new Date(start);
      dayDate.setDate(start.getDate() + index);
      return this.formatLocalDate(dayDate);
    });
  }

  private startOfLocalDay(date: Date): Date {
    const value = new Date(date);
    value.setHours(0, 0, 0, 0);
    return value;
  }

  private formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
