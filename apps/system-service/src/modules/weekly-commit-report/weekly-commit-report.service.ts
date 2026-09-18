import { Injectable } from '@nestjs/common';
import { ParamsErrorException, ProjectException } from '@nest-cloud/common';
import { OpenAiCompatibleClientService } from '../../client/ai/openai-compatible-client.service';
import type {
  DailyReportSection,
  GenerateWeeklyReportInput,
  GitLogEntry,
  WeekWindow,
  WeeklyReportLimits,
  WeeklyReportProgress,
  WeeklyReportProgressReporter,
  WeeklyReportProjectConfig,
  WeeklyReportProjectError,
  WeeklyReportProjectResult,
  WeeklyReportResult,
  WeeklyReportRuntimeConfig,
} from './weekly-report.types';

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

interface ProjectWorkResult {
  config: WeeklyReportProjectConfig;
  repoLabel: string;
  logs: GitLogEntry[];
  bullets: string[];
  degraded: boolean;
}

@Injectable()
export class WeeklyCommitReportService {
  constructor(
    private readonly aiClient: OpenAiCompatibleClientService = new OpenAiCompatibleClientService(),
  ) {}

  async generate(
    input: GenerateWeeklyReportInput,
    progress?: WeeklyReportProgressReporter,
  ): Promise<WeeklyReportResult> {
    const configs = this.resolveConfigs(input.configs, input.runtime);
    progress?.(this.createProgress(configs.length, 0, 0, 'validating', null, '配置校验完成。'));
    const now = new Date();
    const window =
      input.period === 'this-week' ? this.getThisWeekWindow(now) : this.getLastWeekWindow(now);

    if (input.period === 'this-week') {
      return this.generateThisWeek(configs, window, input.runtime, progress);
    }

    return this.generateLastWeek(configs, window, input.runtime, progress);
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
    const subjectLimit =
      logs.length > MAX_DAILY_BULLETS ? MAX_DAILY_BULLETS - 1 : MAX_DAILY_BULLETS;

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
    const displayItems =
      items.length > maxItems
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
        bullets: itemCount > 0 ? displayItems.slice(offset, offset + itemCount) : [NO_NEW_BULLET],
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

    const sectionBlocks = options.sections.map((section) =>
      [
        `## ${this.formatDateWithWeekday(section.date)}`,
        '',
        ...this.normalizeRenderedItems(section.bullets).map(
          (item, index) => `${index + 1}. ${item}`,
        ),
      ].join('\n'),
    );

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
      this.dedupeBullets(
        options.projects.flatMap((project) => project.bullets),
        new Set<string>(),
      ),
    );
    const summaryBlock = [
      '## 本周摘要（去重）',
      '',
      ...summaryItems.map((item, index) => `${index + 1}. ${item}`),
    ].join('\n');

    const projectBlocks = options.projects.map((project) =>
      [
        `## ${project.repoLabel}`,
        '',
        `- Repo: ${project.repo}`,
        `- Person: ${project.person}`,
        `- Branch: ${project.branch}`,
        `- Commits: ${project.commitCount}`,
        '',
        ...this.normalizeRenderedItems(project.bullets).map(
          (item, index) => `${index + 1}. ${item}`,
        ),
      ].join('\n'),
    );

    return `${[header, summaryBlock, ...projectBlocks].join('\n\n')}\n`;
  }

  private async generateThisWeek(
    configs: WeeklyReportProjectConfig[],
    window: WeekWindow,
    runtime: import('./weekly-report.types').WeeklyReportRuntimeConfig,
    progress?: WeeklyReportProgressReporter,
  ): Promise<WeeklyReportResult> {
    const projectWork: ProjectWorkResult[] = [];
    const projectErrors: WeeklyReportProjectError[] = [];
    let completedProjects = 0;
    let failedProjects = 0;
    for (const config of configs) {
      const repoLabel = this.getRepoLabel(config.repo);
      progress?.(
        this.createProgress(
          configs.length,
          completedProjects,
          failedProjects,
          'collecting',
          repoLabel,
          '正在读取 GitHub 提交。',
        ),
      );
      let logs: GitLogEntry[];
      try {
        logs = await this.collectGitLogs(config, window, runtime);
      } catch (error) {
        if (!(error instanceof ProjectException)) throw error;
        projectErrors.push(this.toProjectError(config, repoLabel, error));
        failedProjects += 1;
        completedProjects += 1;
        progress?.(
          this.createProgress(
            configs.length,
            completedProjects,
            failedProjects,
            'collecting',
            null,
            `${repoLabel} 读取失败，已跳过。`,
          ),
        );
        continue;
      }
      progress?.(
        this.createProgress(
          configs.length,
          completedProjects,
          failedProjects,
          'summarizing',
          repoLabel,
          '正在生成项目摘要。',
        ),
      );
      const summary =
        logs.length === 0
          ? { bullets: [NO_COMMIT_BULLET], degraded: false }
          : await this.summarizeProject(
              logs,
              {
                person: config.person,
                repoLabel,
                weekStart: window.dayKeys[0],
                weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
              },
              runtime,
            );
      projectWork.push({
        config,
        repoLabel,
        logs,
        bullets: summary.bullets,
        degraded: summary.degraded,
      });
      completedProjects += 1;
    }

    progress?.(
      this.createProgress(
        configs.length,
        completedProjects,
        failedProjects,
        'finalizing',
        null,
        '正在整理 Markdown 报告。',
      ),
    );
    const projects = projectWork.map((work) => ({
      repo: work.config.repo,
      repoLabel: work.repoLabel,
      person: work.config.person,
      branch: work.config.branch ?? 'HEAD',
      commitCount: work.logs.length,
      bullets: work.bullets,
    }));
    const markdown = this.limitOutput(
      this.appendProjectErrors(
        this.renderThisWeekReport({
          person: this.getPersonLabel(projects.length > 0 ? projects : configs),
          weekStart: window.dayKeys[0],
          weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
          projects,
        }),
        projectErrors,
      ),
      runtime,
    );

    progress?.(
      this.createProgress(
        configs.length,
        completedProjects,
        failedProjects,
        'completed',
        null,
        '周报已生成。',
      ),
    );
    return {
      period: 'this-week',
      weekStart: window.dayKeys[0],
      weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
      markdown,
      projects,
      projectErrors,
      commitCount: projects.reduce((total, project) => total + project.commitCount, 0),
      degraded: projectWork.some((work) => work.degraded),
    };
  }

  private async generateLastWeek(
    configs: WeeklyReportProjectConfig[],
    window: WeekWindow,
    runtime: import('./weekly-report.types').WeeklyReportRuntimeConfig,
    progress?: WeeklyReportProgressReporter,
  ): Promise<WeeklyReportResult> {
    const mergedBullets: string[] = [];
    const projectResults: WeeklyReportProjectResult[] = [];
    const projectErrors: WeeklyReportProjectError[] = [];
    const successfulConfigs: WeeklyReportProjectConfig[] = [];
    let completedProjects = 0;
    let failedProjects = 0;
    let degraded = false;

    for (const config of configs) {
      const repoLabel = this.getRepoLabel(config.repo);
      progress?.(
        this.createProgress(
          configs.length,
          completedProjects,
          failedProjects,
          'collecting',
          repoLabel,
          '正在读取 GitHub 提交。',
        ),
      );
      let logs: GitLogEntry[];
      try {
        logs = await this.collectGitLogs(config, window, runtime);
      } catch (error) {
        if (!(error instanceof ProjectException)) throw error;
        projectErrors.push(this.toProjectError(config, repoLabel, error));
        failedProjects += 1;
        completedProjects += 1;
        progress?.(
          this.createProgress(
            configs.length,
            completedProjects,
            failedProjects,
            'collecting',
            null,
            `${repoLabel} 读取失败，已跳过。`,
          ),
        );
        continue;
      }
      progress?.(
        this.createProgress(
          configs.length,
          completedProjects,
          failedProjects,
          'summarizing',
          repoLabel,
          '正在生成日报摘要。',
        ),
      );
      const summary = await this.buildDailySections(
        logs,
        window.dayKeys,
        {
          person: config.person,
          repoLabel,
        },
        runtime,
      );
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
      successfulConfigs.push(config);
      completedProjects += 1;
    }

    progress?.(
      this.createProgress(
        configs.length,
        completedProjects,
        failedProjects,
        'finalizing',
        null,
        '正在整理 Markdown 报告。',
      ),
    );
    const sections = this.distributeBulletsAcrossDays(
      this.dedupeBullets(mergedBullets, new Set<string>()),
      window.dayKeys.slice(0, 5),
    );
    const markdown = this.limitOutput(
      this.appendProjectErrors(
        this.renderLastWeekReport({
          person: this.getPersonLabel(projectResults.length > 0 ? projectResults : configs),
          weekStart: window.dayKeys[0],
          weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
          projects: successfulConfigs,
          sections,
        }),
        projectErrors,
      ),
      runtime,
    );

    progress?.(
      this.createProgress(
        configs.length,
        completedProjects,
        failedProjects,
        'completed',
        null,
        '周报已生成。',
      ),
    );
    return {
      period: 'last-week',
      weekStart: window.dayKeys[0],
      weekEnd: window.dayKeys.at(-1) ?? window.dayKeys[0],
      markdown,
      projects: projectResults,
      projectErrors,
      commitCount: projectResults.reduce((total, project) => total + project.commitCount, 0),
      degraded,
      dailySections: sections,
    };
  }

  private createProgress(
    totalProjects: number,
    completedProjects: number,
    failedProjects: number,
    phase: WeeklyReportProgress['phase'],
    currentProject: string | null,
    message: string,
  ): WeeklyReportProgress {
    const totalUnits = Math.max(totalProjects + 1, 1);
    const percent =
      phase === 'completed'
        ? 100
        : Math.min(99, Math.floor((completedProjects / totalUnits) * 100));
    return {
      phase,
      percent,
      completedProjects,
      totalProjects,
      failedProjects,
      currentProject,
      message,
    };
  }

  private toProjectError(
    config: WeeklyReportProjectConfig,
    repoLabel: string,
    error: ProjectException,
  ): WeeklyReportProjectError {
    return {
      repo: config.repo,
      repoLabel,
      code: error.getStatus(),
      message: error.message || '项目提交信息读取失败。',
    };
  }

  private appendProjectErrors(markdown: string, errors: WeeklyReportProjectError[]): string {
    if (errors.length === 0) return markdown;
    const lines = errors.map(
      (error) =>
        `- ${error.repoLabel}（${error.code}）：${error.message.replace(/\s+/g, ' ').trim()}`,
    );
    return `${markdown}\n## 项目异常\n\n${lines.join('\n')}\n`;
  }

  private async buildDailySections(
    logs: GitLogEntry[],
    dayKeys: string[],
    context: Pick<SummaryContext, 'person' | 'repoLabel'>,
    runtime: WeeklyReportRuntimeConfig,
  ): Promise<{ sections: DailyReportSection[]; degraded: boolean }> {
    const sections: DailyReportSection[] = [];
    const seenBulletKeys = new Set<string>();
    let degraded = false;

    for (const group of this.groupLogsByDay(logs, dayKeys)) {
      if (group.logs.length === 0) {
        sections.push({ date: group.date, logs: [], bullets: [NO_COMMIT_BULLET] });
        continue;
      }

      const summary = await this.summarizeDaily(
        group.logs,
        {
          date: group.date,
          person: context.person,
          repoLabel: context.repoLabel,
          priorBullets: sections.flatMap((section) => section.bullets),
        },
        runtime,
      );
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
    runtime: WeeklyReportRuntimeConfig,
  ): Promise<GitLogEntry[]> {
    const repository = this.parseGitHubRepository(config.repo);
    const token = runtime.githubToken.trim();

    const limits = this.getLimits(runtime);
    const maxCommits = limits.maxCommitsPerRepository;
    const maxPages = Math.ceil(maxCommits / 100) + 1;
    const logs: GitLogEntry[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const url = new URL(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits`,
      );
      if (config.branch) url.searchParams.set('sha', config.branch);
      url.searchParams.set('author', config.person);
      url.searchParams.set('since', window.start.toISOString());
      url.searchParams.set('until', window.end.toISOString());
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), limits.commandTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new ProjectException('GitHub 提交请求超时，请稍后重试。', 504);
        }
        throw new ProjectException('GitHub 提交请求失败，请稍后重试。', 502);
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new ProjectException(
          `GitHub API error: ${response.status} ${await response.text()}`,
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ProjectException('GitHub 提交响应格式无效。', 502);
      }
      if (!Array.isArray(payload)) throw new ProjectException('GitHub 提交响应格式无效。', 502);

      for (const item of payload) {
        const log = this.mapGitHubCommit(item, config.person);
        if (log) logs.push(log);
        if (logs.length >= maxCommits) return logs.slice(0, maxCommits);
      }
      if (payload.length < 100) break;
    }

    if (logs.length >= maxCommits) return logs.slice(0, maxCommits);
    return logs;
  }

  private mapGitHubCommit(value: unknown, fallbackAuthor: string): GitLogEntry | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as {
      sha?: unknown;
      parents?: unknown;
      author?: { login?: unknown };
      commit?: {
        message?: unknown;
        author?: { name?: unknown; email?: unknown; date?: unknown };
        committer?: { date?: unknown };
      };
    };
    const message = record.commit?.message;
    const hash = typeof record.sha === 'string' ? record.sha : '';
    const dateValue = record.commit?.author?.date ?? record.commit?.committer?.date;
    const date = typeof dateValue === 'string' ? dateValue : '';
    if (!hash || !date || Number.isNaN(Date.parse(date)) || typeof message !== 'string')
      return undefined;

    const lines = message.split(/\r?\n/);
    const subject = lines.shift()?.trim() ?? '';
    if (!subject || subject.startsWith('Merge pull request') || subject.startsWith('Merge branch'))
      return undefined;
    if (Array.isArray(record.parents) && record.parents.length > 1) return undefined;

    const authorName = record.commit?.author?.name;
    const authorLogin = record.author?.login;
    const authorEmail = record.commit?.author?.email;
    const author =
      typeof authorName === 'string' && authorName
        ? authorName
        : typeof authorLogin === 'string' && authorLogin
          ? authorLogin
          : typeof authorEmail === 'string' && authorEmail
            ? authorEmail
            : fallbackAuthor;
    return { hash, author, date, subject, body: lines.join('\n').trim() };
  }

  private parseGitHubRepository(repo: string): { owner: string; name: string } {
    let parsed: URL;
    try {
      parsed = new URL(repo);
    } catch {
      throw new ParamsErrorException('周报仅支持有效的 GitHub HTTPS 仓库地址。');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== 'github.com' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.port && parsed.port !== '443')
    ) {
      throw new ParamsErrorException('周报仅支持无凭据的 GitHub HTTPS 仓库地址。');
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) throw new ParamsErrorException('GitHub 仓库地址格式无效。');
    const owner = decodeURIComponent(segments[0]);
    const name = decodeURIComponent(segments[1]).replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      throw new ParamsErrorException('GitHub 仓库地址格式无效。');
    }
    return { owner, name };
  }

  private async summarizeDaily(
    logs: GitLogEntry[],
    context: SummaryContext,
    runtime: WeeklyReportRuntimeConfig,
  ): Promise<SummaryResult> {
    const prompt = this.buildDailySummaryPrompt(logs, context, runtime);
    const ai = this.getAiConfig(runtime);
    const aiBullets = await this.requestAiSummary(ai, prompt, '研发日报助手', runtime);
    if (aiBullets) return { bullets: aiBullets, degraded: false };
    return { bullets: this.buildLocalSummary(logs), degraded: true };
  }

  private async summarizeProject(
    logs: GitLogEntry[],
    context: SummaryContext,
    runtime: WeeklyReportRuntimeConfig,
  ): Promise<SummaryResult> {
    const prompt = this.buildProjectSummaryPrompt(logs, context, runtime);
    const ai = this.getAiConfig(runtime);
    const aiBullets = await this.requestAiSummary(ai, prompt, '研发周报助手', runtime);
    if (aiBullets) return { bullets: aiBullets, degraded: false };
    return { bullets: this.buildLocalSummary(logs), degraded: true };
  }

  private async requestAiSummary(
    ai: { baseUrl: string; apiKey: string; model: string },
    prompt: string,
    role: string,
    runtime: WeeklyReportRuntimeConfig,
  ): Promise<string[] | undefined> {
    const content = await this.aiClient.request({
      ai,
      prompt,
      systemMessage: `你是一名${role}。请只输出简洁、准确、适合直接汇报的中文有序列表。每行只输出一条，使用 1. 2. 这样的编号格式，不要输出标题、段落、commit hash 或虚构事实。只保留实际开发、修复、配置、测试或发布成果。`,
      timeoutMs: this.getLimits(runtime).aiTimeoutMs,
      maxPromptCharacters: this.getLimits(runtime).maxPromptCharacters,
      maxResponseCharacters: MAX_AI_RESPONSE_CHARACTERS,
    });
    if (!content) return undefined;
    const bullets = this.normalizeBulletLines(content);
    return bullets.length > 0 ? bullets : undefined;
  }

  private buildDailySummaryPrompt(
    logs: GitLogEntry[],
    context: SummaryContext,
    runtime: WeeklyReportRuntimeConfig,
  ): string {
    const commitLines = logs
      .slice(0, this.getLimits(runtime).maxPromptCommits)
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

  private buildProjectSummaryPrompt(
    logs: GitLogEntry[],
    context: SummaryContext,
    runtime: WeeklyReportRuntimeConfig,
  ): string {
    const commitLines = logs
      .slice(0, this.getLimits(runtime).maxPromptCommits)
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

  private resolveConfigs(
    configs: WeeklyReportProjectConfig[],
    runtime: WeeklyReportRuntimeConfig,
  ): WeeklyReportProjectConfig[] {
    const limits = this.getLimits(runtime);
    if (configs.length === 0 || configs.length > limits.maxProjects) {
      throw new ParamsErrorException(`周报项目数量必须在 1 到 ${limits.maxProjects} 个之间。`);
    }

    return configs.map((config) => {
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
      this.assertAllowedRepository(repo, runtime);
      return { repo, person, ...(branch ? { branch } : {}) };
    });
  }

  private assertAllowedRepository(repo: string, runtime: WeeklyReportRuntimeConfig): void {
    const allowedRepos = runtime.allowedRepositories?.length ? runtime.allowedRepositories : [repo];
    if (!allowedRepos.some((item) => this.canonicalRepo(item) === this.canonicalRepo(repo))) {
      throw new ParamsErrorException('仓库不在周报允许访问列表中。');
    }
    this.parseGitHubRepository(repo);
  }

  private getAiConfig(runtime: WeeklyReportRuntimeConfig) {
    return {
      baseUrl: runtime.ai?.baseUrl?.trim() ?? '',
      apiKey: runtime.ai?.apiKey?.trim() ?? '',
      model: runtime.ai?.model?.trim() ?? '',
    };
  }

  private getLimits(runtime: WeeklyReportRuntimeConfig): WeeklyReportLimits {
    const limits = runtime.limits ?? {};
    return {
      maxProjects: limits.maxProjects ?? 10,
      maxCommitsPerRepository: limits.maxCommitsPerRepository ?? 100,
      maxPromptCommits: limits.maxPromptCommits ?? 40,
      maxPromptCharacters: limits.maxPromptCharacters ?? 30_000,
      maxOutputCharacters: limits.maxOutputCharacters ?? 100_000,
      commandTimeoutMs: limits.commandTimeoutMs ?? 60_000,
      aiTimeoutMs: limits.aiTimeoutMs ?? 30_000,
    };
  }

  private limitOutput(content: string, runtime: WeeklyReportRuntimeConfig): string {
    const limit = this.getLimits(runtime).maxOutputCharacters;
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
      return repo
        .trim()
        .replace(/[\\/]+$/, '')
        .replace(/\.git$/i, '')
        .toLowerCase();
    }
  }

  private normalizeCommitSubject(subject: string): string {
    const trimmed = subject.trim();
    return trimmed.replace(CONVENTIONAL_COMMIT_PREFIX, '').trim() || trimmed;
  }

  private normalizeSummaryLine(line: string): string {
    return this.normalizeCommitSubject(
      line
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .trim(),
    );
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
      if (
        !normalized ||
        this.isPlaceholderBullet(normalized) ||
        this.isCodeIntegrationBullet(normalized)
      )
        continue;
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
    return /^(?:(?:merge|rebase|cherry-pick)\b.*|(?:合并|合入|同步)\s*(?:(?:[\w./-]+\s*)?(?:分支|代码|主分支|PR|MR|请求))|(?:解决|处理)\s*合并冲突)/i.test(
      normalized,
    );
  }

  private isPlaceholderBullet(bullet: string): boolean {
    return bullet === NO_COMMIT_BULLET || bullet === NO_NEW_BULLET;
  }

  private firstMeaningfulBodyLine(body: string): string | undefined {
    return body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
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
