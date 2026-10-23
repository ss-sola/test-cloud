import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectException } from '@nest-cloud/common';
import { AiTextClientService } from '../client/ai/ai-text-client.service';
import { WeeklyCommitReportService } from '../modules/weekly-commit-report/weekly-commit-report.service';
import type {
  GitLogEntry,
  WeekWindow,
  WeeklyReportProjectConfig,
  WeeklyReportRuntimeConfig,
} from '../modules/weekly-commit-report/weekly-report.types';

const ai = { baseUrl: 'https://ai.example.com/v1', apiKey: 'ai-test-key', model: 'test-model' };
const runtime: WeeklyReportRuntimeConfig = { githubToken: 'test-token', ai };

/** 解析提示词末行的提交 JSON，按序号回显标题，模拟一次合格的 AI 摘要。 */
function echoSubjects(prompt: string): string {
  const commits = JSON.parse(prompt.split('\n').at(-1)!) as GitLogEntry[];
  return commits.map((entry, index) => `${index + 1}. ${entry.subject}`).join('\n');
}

// 共享实例的 AI 客户端默认回显标题，任何未显式 mock 的用例都不会触发真实外呼。
const sharedAiClient = new AiTextClientService();
const service = new WeeklyCommitReportService(sharedAiClient);

beforeEach(() => {
  vi.spyOn(sharedAiClient, 'generate').mockImplementation(async (options) =>
    echoSubjects(options.prompt),
  );
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected network call')));
});

const log = (
  overrides: Partial<{
    hash: string;
    author: string;
    date: string;
    subject: string;
    body: string;
  }> = {},
) => ({
  hash: 'abc123',
  author: 'ljh',
  date: '2026-04-07T09:00:00+08:00',
  subject: 'feat: 新增周报生成',
  body: '',
  ...overrides,
});

const window: WeekWindow = {
  start: new Date('2026-04-06T00:00:00+08:00'),
  end: new Date('2026-04-13T00:00:00+08:00'),
  dayKeys: ['2026-04-06', '2026-04-07', '2026-04-08'],
};

interface CommitCollector {
  collectGitLogs(
    config: WeeklyReportProjectConfig,
    window: WeekWindow,
    runtime: { githubToken: string },
  ): Promise<GitLogEntry[]>;
  generateThisWeek(
    configs: WeeklyReportProjectConfig[],
    window: WeekWindow,
    runtime: { githubToken: string },
  ): Promise<unknown>;
  generateLastWeek(
    configs: WeeklyReportProjectConfig[],
    window: WeekWindow,
    runtime: { githubToken: string },
  ): Promise<unknown>;
}

function collect(config: WeeklyReportProjectConfig, requestRuntime = runtime) {
  return (service as unknown as CommitCollector).collectGitLogs(config, window, requestRuntime);
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function githubCommit(overrides: Record<string, unknown> = {}) {
  return {
    sha: 'abc123',
    author: { login: 'github-user' },
    parents: [{ sha: 'parent' }],
    commit: {
      message: 'feat: add weekly report\n\nAdd report details.',
      author: {
        name: 'GitHub User',
        email: '2451477516@qq.com',
        date: '2026-04-07T09:00:00+08:00',
      },
      committer: { date: '2026-04-07T09:01:00+08:00' },
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WeeklyCommitReportService', () => {
  it('calculates the previous complete Monday-to-Sunday window', () => {
    const result = service.getLastWeekWindow(new Date('2026-04-17T12:00:00+08:00'));

    expect(result.dayKeys).toEqual([
      '2026-04-06',
      '2026-04-07',
      '2026-04-08',
      '2026-04-09',
      '2026-04-10',
      '2026-04-11',
      '2026-04-12',
    ]);
    expect(result.start.getHours()).toBe(0);
    expect(result.end.getHours()).toBe(0);
  });

  it('calculates the current week through today', () => {
    const result = service.getThisWeekWindow(new Date('2026-04-17T12:00:00+08:00'));

    expect(result.dayKeys).toEqual([
      '2026-04-13',
      '2026-04-14',
      '2026-04-15',
      '2026-04-16',
      '2026-04-17',
    ]);
    expect(result.end.toISOString()).toBe('2026-04-17T04:00:00.000Z');
  });

  it('queries GitHub commits with branch, author, and date window parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([githubCommit()]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect({
      repo: 'https://github.com/whtthd/wzj-nodejs-v2.git',
      person: '2451477516@qq.com',
      branch: 'merge/wzj-temp',
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));

    expect(result).toEqual([
      {
        hash: 'abc123',
        author: 'GitHub User',
        date: '2026-04-07T09:00:00+08:00',
        subject: 'feat: add weekly report',
        body: 'Add report details.',
      },
    ]);
    expect(url.pathname).toBe('/repos/whtthd/wzj-nodejs-v2/commits');
    expect(url.searchParams.get('sha')).toBe('merge/wzj-temp');
    expect(url.searchParams.get('author')).toBe('2451477516@qq.com');
    expect(url.searchParams.get('since')).toBe(window.start.toISOString());
    expect(url.searchParams.get('until')).toBe(window.end.toISOString());
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.get('page')).toBe('1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe('application/vnd.github+json');
  });

  it('maps author and committer fallbacks and filters merge commits', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        githubCommit({
          sha: 'merge-1',
          parents: [{ sha: 'one' }, { sha: 'two' }],
          commit: { message: 'normal message', author: { date: '2026-04-07T09:00:00+08:00' } },
        }),
        githubCommit({
          sha: 'merge-2',
          commit: {
            message: 'Merge pull request #1',
            author: { name: 'Bot', date: '2026-04-07T09:00:00+08:00' },
          },
        }),
        githubCommit({
          sha: 'merge-3',
          commit: {
            message: 'Merge branch feature/report',
            author: { name: 'Bot', date: '2026-04-07T09:00:00+08:00' },
          },
        }),
        githubCommit({
          sha: 'fallback',
          author: { login: 'fallback-login' },
          commit: {
            message: 'fix: fallback author',
            author: { date: undefined },
            committer: { date: '2026-04-08T09:00:00+08:00' },
          },
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect({
      repo: 'https://github.com/example/demo.git',
      person: 'fallback-person',
      branch: 'main',
    });

    expect(result.map(({ hash, author, date }) => ({ hash, author, date }))).toEqual([
      { hash: 'fallback', author: 'fallback-login', date: '2026-04-08T09:00:00+08:00' },
    ]);
  });

  it('paginates when a full page contains only merge commits', async () => {
    const mergePage = Array.from({ length: 100 }, (_, index) =>
      githubCommit({
        sha: `merge-${index}`,
        parents: [{ sha: 'one' }, { sha: 'two' }],
        commit: {
          message: 'Merge branch feature/report',
          author: { name: 'Bot', date: '2026-04-07T09:00:00+08:00' },
        },
      }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(mergePage))
      .mockResolvedValueOnce(jsonResponse([githubCommit({ sha: 'valid' })]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect({
      repo: 'https://github.com/example/demo.git',
      person: 'person@example.com',
      branch: 'main',
    });

    expect(result).toHaveLength(1);
    expect(result[0].hash).toBe('valid');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('page')).toBe('2');
  });

  it('omits sha when no branch is configured and stops on a short page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([githubCommit()]));
    vi.stubGlobal('fetch', fetchMock);

    await collect({ repo: 'https://github.com/example/demo.git', person: 'person@example.com' });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.has('sha')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps GitHub API errors and invalid responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'not found' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      collect({
        repo: 'https://github.com/example/demo.git',
        person: 'person@example.com',
        branch: 'main',
      }),
    ).rejects.toMatchObject({ status: 404 });

    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    await expect(
      collect({
        repo: 'https://github.com/example/demo.git',
        person: 'person@example.com',
        branch: 'main',
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('skips a failed project and continues with later projects this week', async () => {
    const internal = service as unknown as CommitCollector;
    const configs = [
      { repo: 'https://github.com/example/failed.git', person: 'one@example.com', branch: 'main' },
      {
        repo: 'https://github.com/example/success-a.git',
        person: 'two@example.com',
        branch: 'main',
      },
      {
        repo: 'https://github.com/example/success-b.git',
        person: 'three@example.com',
        branch: 'main',
      },
    ];
    const collectMock = vi
      .spyOn(internal, 'collectGitLogs')
      .mockRejectedValueOnce(new ProjectException('GitHub API error: 404', 404))
      .mockResolvedValueOnce([log({ hash: 'success-a', subject: 'feat: 支持考试成绩查询' })])
      .mockResolvedValueOnce([log({ hash: 'success-b', subject: 'fix: 修复考试成绩排序' })]);

    const result = (await internal.generateThisWeek(configs, window, runtime)) as {
      projects: Array<{ repo: string; commitCount: number }>;
      projectErrors: Array<{ repo: string; repoLabel: string; code: number; message: string }>;
      commitCount: number;
      markdown: string;
    };

    expect(collectMock).toHaveBeenCalledTimes(3);
    expect(result.projects.map((project) => project.repo)).toEqual([
      configs[1].repo,
      configs[2].repo,
    ]);
    expect(result.commitCount).toBe(2);
    expect(result.projectErrors).toEqual([
      {
        repo: configs[0].repo,
        repoLabel: 'failed',
        code: 404,
        message: 'GitHub API error: 404',
      },
    ]);
    expect(result.markdown).toContain('## 项目异常');
    expect(result.markdown).toContain('项目：failed（404）');
    expect(result.markdown).toContain('支持考试成绩查询');
    expect(result.markdown).toContain('修复考试成绩排序');
    expect(result.markdown).toMatch(/\p{Script=Han}/u);
  });

  it('excludes failed projects from last-week totals and renders Chinese errors', async () => {
    const internal = service as unknown as CommitCollector;
    const configs = [
      { repo: 'https://github.com/example/failed.git', person: 'one@example.com', branch: 'main' },
      { repo: 'https://github.com/example/success.git', person: 'two@example.com', branch: 'main' },
    ];
    vi.spyOn(internal, 'collectGitLogs')
      .mockRejectedValueOnce(new ProjectException('GitHub API error: 502', 502))
      .mockResolvedValueOnce([log({ hash: 'success', date: '2026-04-07T09:00:00+08:00' })]);

    const result = (await internal.generateLastWeek(configs, window, runtime)) as {
      projects: Array<{ repo: string }>;
      projectErrors: Array<{ code: number }>;
      markdown: string;
    };

    expect(result.projects.map((project) => project.repo)).toEqual([configs[1].repo]);
    expect(result.projectErrors).toHaveLength(1);
    expect(result.projectErrors[0].code).toBe(502);
    expect(result.markdown).toContain('- 项目数量：1');
    expect(result.markdown).toContain('项目：failed（502）');
    expect(result.markdown).toContain('- 来源：success@main');
    expect(result.markdown).not.toContain('failed@main');
    expect(result.markdown).toMatch(/\p{Script=Han}/u);
  });

  it('returns an empty project error list when every project succeeds', async () => {
    const internal = service as unknown as CommitCollector;
    const configs = [
      {
        repo: 'https://github.com/example/success.git',
        person: 'person@example.com',
        branch: 'main',
      },
    ];
    vi.spyOn(internal, 'collectGitLogs').mockResolvedValue([log()]);

    const result = (await internal.generateThisWeek(configs, window, runtime)) as {
      projectErrors: unknown[];
    };

    expect(result.projectErrors).toEqual([]);
  });

  it('groups mapped log records by local date', () => {
    const parsed = [
      log({ hash: 'one', date: '2026-04-07T09:00:00+08:00', subject: 'fix: first' }),
      log({ hash: 'two', date: '2026-04-08T09:00:00+08:00', subject: 'docs: second' }),
    ];
    const grouped = service.groupLogsByDay(parsed, ['2026-04-07', '2026-04-08', '2026-04-09']);

    expect(parsed).toHaveLength(2);
    expect(grouped.map((entry) => entry.logs.length)).toEqual([1, 1, 0]);
    expect(grouped[0].logs[0].hash).toBe('one');
  });

  it('no longer exposes a local summary builder', () => {
    expect('buildLocalSummary' in service).toBe(false);
  });

  it('distributes unique report bullets across workdays', () => {
    const sections = service.distributeBulletsAcrossDays(
      ['one', 'two', 'two', 'three'],
      ['2026-04-06', '2026-04-07'],
    );

    expect(sections.map((section) => section.bullets)).toEqual([['one', 'two'], ['three']]);
  });

  it('keeps every distinct AI bullet beyond five entries and drops duplicates', () => {
    const subjects = Array.from({ length: 12 }, (_, index) => `补充考试规则 ${index + 1}`);
    const content = [...subjects, subjects[0]].map((item, index) => `${index + 1}. ${item}`);

    expect(service.normalizeBulletLines(content.join('\n'))).toEqual(subjects);
  });

  it('distributes and renders all work instead of folding items beyond 25', () => {
    const bullets = Array.from({ length: 33 }, (_, index) => `实现考试业务规则 ${index + 1}`);
    const dayKeys = ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'];
    const sections = service.distributeBulletsAcrossDays(bullets, dayKeys);
    const projects = [
      { repo: 'https://github.com/example/demo.git', person: 'ljh', branch: 'main' },
    ];
    const lastWeek = service.renderLastWeekReport({
      person: 'ljh',
      weekStart: dayKeys[0],
      weekEnd: dayKeys.at(-1)!,
      projects,
      sections,
    });
    const thisWeek = service.renderThisWeekReport({
      person: 'ljh',
      weekStart: dayKeys[0],
      weekEnd: dayKeys.at(-1)!,
      projects: [{ ...projects[0], repoLabel: 'demo', commitCount: bullets.length, bullets }],
    });

    expect(sections.flatMap((section) => section.bullets)).toEqual(bullets);
    expect(sections.map((section) => section.bullets.length)).toEqual([7, 7, 7, 6, 6]);
    expect(lastWeek.match(/^\d+\. /gm)).toHaveLength(33);
    expect(thisWeek.match(/^\d+\. /gm)).toHaveLength(66);
    for (const markdown of [lastWeek, thisWeek]) {
      expect(markdown).toContain('实现考试业务规则 33');
      expect(markdown).not.toMatch(/其余|未展开|细节调整和配套修改/);
    }
  });

  it.each(['last-week', 'this-week'] as const)(
    'uses business-oriented Chinese instructions and complete commit bodies for %s',
    async (period) => {
      const aiClient = new AiTextClientService();
      const outcomes = [
        '更新 1.12.0 版本发布产物',
        '从 1.12.0 发布配置中排除课堂笔记相关配置',
        '发布 1.12.0 版本',
        '补充 1.12.0 数据平台数据库脚本',
        '补充 1.12.0 学校发布环境配置',
        '支持考试成绩自动公布',
        '恢复被打回答卷的作答状态',
      ];
      const request = vi
        .spyOn(aiClient, 'generate')
        .mockResolvedValue(outcomes.map((item, index) => `${index + 1}. ${item}`).join('\n'));
      const reportService = new WeeklyCommitReportService(aiClient);
      vi.spyOn(reportService, 'getLastWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
      const body = '发布说明\n\n补充数据平台 SQL 脚本\n补充学校发布环境配置';
      vi.spyOn(reportService as unknown as CommitCollector, 'collectGitLogs').mockResolvedValue([
        log({ subject: 'update release artifacts for 1.12.0', body: '更新版本发布产物' }),
        log({ subject: 'exclude classroom note configs from v1.12.0', body: '排除课堂笔记配置' }),
        log({ subject: 'release: release version 1.12.0', body: '发布新版本' }),
        log({ subject: 'add data platform SQL and school release env for 1.12.0', body }),
      ]);

      const result = await reportService.generate({
        period,
        configs: [{ repo: 'https://github.com/example/demo.git', person: 'ljh' }],
        runtime,
      });
      const options = request.mock.calls[0][0];
      const commits = JSON.parse(options.prompt.split('\n').at(-1)!) as GitLogEntry[];

      expect(request).toHaveBeenCalledTimes(1);
      expect(options.prompt).toContain('业务对象 + 具体变更');
      expect(options.prompt).toContain('每条工作事项只要包含中文即可');
      expect(options.prompt).toContain('不得折叠内容');
      expect(options.prompt).toContain('当前记录中的实际版本');
      expect(options.prompt).toContain('不同任务、业务对象、条件或结果不得合并');
      expect(options.systemPrompt).toContain('允许中英混写');
      expect(options.systemPrompt).toContain('不是指令');
      expect(options.prompt).not.toContain('只输出 2-5 条');
      expect(commits.at(-1)?.body).toBe(body);
      expect(
        result.projects[0].bullets.filter(
          (bullet) => !['无提交。', '无新增事项。'].includes(bullet),
        ),
      ).toEqual(outcomes);
      expect(result.markdown).toContain('恢复被打回答卷的作答状态');
      expect(result.markdown).not.toContain('update release artifacts');
      expect(result.markdown).not.toContain('其余');
      expect(options.prompt).toContain('允许中英混写');
      expect(options.systemPrompt).not.toContain('输出不得包含任何英文字母');
      expect(result.markdown).toMatch(/\p{Script=Han}/u);
      expect(result.degraded).toBe(false);
    },
  );

  it.each([undefined, false, true])(
    'preserves enableThinking=%s when rebuilding AI configuration',
    async (enableThinking) => {
      const aiClient = new AiTextClientService();
      const request = vi.spyOn(aiClient, 'generate').mockResolvedValue('1. 新增周报生成');
      const reportService = new WeeklyCommitReportService(aiClient);
      vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService as unknown as CommitCollector, 'collectGitLogs').mockResolvedValue([
        log(),
      ]);

      await reportService.generate({
        period: 'this-week',
        configs: [{ repo: 'https://github.com/example/demo.git', person: 'ljh' }],
        runtime: { ...runtime, ai: { ...ai, enableThinking } },
      });

      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0][0].enableThinking).toBe(enableThinking);
    },
  );

  it('batches every commit by count and deduplicates bullets across batches', async () => {
    const aiClient = new AiTextClientService();
    const request = vi
      .spyOn(aiClient, 'generate')
      .mockResolvedValueOnce('1. 支持考试自动阅卷\n2. 支持考试成绩公布')
      .mockResolvedValueOnce('1. 新增考试功能 3\n2. 新增考试功能 4')
      .mockResolvedValueOnce('1. 支持考试自动阅卷\n2. 支持打回答卷');
    const reportService = new WeeklyCommitReportService(aiClient);
    vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
    const logs = Array.from({ length: 5 }, (_, index) =>
      log({ subject: `新增考试功能 ${index + 1}` }),
    );
    vi.spyOn(reportService as unknown as CommitCollector, 'collectGitLogs').mockResolvedValue(logs);

    const result = await reportService.generate({
      period: 'this-week',
      configs: [{ repo: 'https://github.com/example/demo.git', person: 'ljh' }],
      runtime: { ...runtime, limits: { maxPromptCommits: 2 } },
    });
    const inputBatches = request.mock.calls.map(
      ([options]) => JSON.parse(options.prompt.split('\n').at(-1)!) as GitLogEntry[],
    );

    expect(inputBatches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(inputBatches.flatMap((batch) => batch.map((entry) => entry.subject))).toEqual(
      logs.map((entry) => entry.subject),
    );
    expect(result.projects[0].bullets).toEqual([
      '支持考试自动阅卷',
      '支持考试成绩公布',
      '新增考试功能 3',
      '新增考试功能 4',
      '支持打回答卷',
    ]);
    expect(result.degraded).toBe(false);
  });

  it('splits batches by the full prompt budget and keeps every commit body intact', async () => {
    const aiClient = new AiTextClientService();
    const request = vi
      .spyOn(aiClient, 'generate')
      .mockImplementation(async (options) => echoSubjects(options.prompt));
    const reportService = new WeeklyCommitReportService(aiClient);
    vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
    const logs = [
      log({ subject: '补充考试说明一', body: '甲'.repeat(2_500) }),
      log({ subject: '补充考试说明二', body: '乙'.repeat(2_500) }),
      log({ subject: '补充考试说明三', body: '丁'.repeat(2_500) }),
    ];
    vi.spyOn(reportService as unknown as CommitCollector, 'collectGitLogs').mockResolvedValue(logs);

    const result = await reportService.generate({
      period: 'this-week',
      configs: [{ repo: 'https://github.com/example/demo.git', person: 'ljh' }],
      runtime: { ...runtime, limits: { maxPromptCharacters: 5_000 } },
    });

    expect(request).toHaveBeenCalledTimes(3);
    for (const [options] of request.mock.calls) {
      expect(options.maxPromptCharacters).toBeDefined();
      expect(options.prompt.length).toBeLessThanOrEqual(options.maxPromptCharacters!);
      const commits = JSON.parse(options.prompt.split('\n').at(-1)!) as GitLogEntry[];
      expect(commits).toHaveLength(1);
      expect(commits[0].body).toHaveLength(2_500);
    }
    expect(result.projects[0].bullets).toEqual(logs.map((entry) => entry.subject));
    expect(result.degraded).toBe(false);
  });

  it.each(['last-week', 'this-week'] as const)(
    'fails explicitly instead of returning truncated %s Markdown',
    async (period) => {
      const reportService = new WeeklyCommitReportService(sharedAiClient);
      vi.spyOn(reportService, 'getLastWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService as unknown as CommitCollector, 'collectGitLogs').mockResolvedValue([
        log({ subject: '补充考试业务规则'.repeat(300) }),
      ]);

      await expect(
        reportService.generate({
          period,
          configs: [{ repo: 'https://github.com/example/demo.git', person: 'ljh' }],
          runtime: { ...runtime, limits: { maxOutputCharacters: 1_000 } },
        }),
      ).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('未返回截断报告'),
      });
    },
  );

  describe('without local fallback', () => {
    const configs = [{ repo: 'https://github.com/example/demo.git', person: 'ljh' }];
    const periods = ['last-week', 'this-week'] as const;

    /** 构造使用独立 AI 客户端的服务，窗口固定且 GitHub 采集返回给定提交。 */
    function createReportService(logs: GitLogEntry[]) {
      const aiClient = new AiTextClientService();
      const request = vi
        .spyOn(aiClient, 'generate')
        .mockImplementation(async (options) => echoSubjects(options.prompt));
      const reportService = new WeeklyCommitReportService(aiClient);
      vi.spyOn(reportService, 'getLastWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
      const collectMock = vi
        .spyOn(reportService as unknown as CommitCollector, 'collectGitLogs')
        .mockResolvedValue(logs);
      return { request, reportService, collectMock };
    }

    it.each(
      periods.flatMap((period) =>
        (
          [
            ['missing ai object', undefined],
            ['empty baseUrl', { ...ai, baseUrl: '' }],
            ['blank baseUrl', { ...ai, baseUrl: '   ' }],
            ['empty apiKey', { ...ai, apiKey: '' }],
            ['blank apiKey', { ...ai, apiKey: ' \t ' }],
            ['empty model', { ...ai, model: '' }],
            ['blank model', { ...ai, model: '  ' }],
          ] as const
        ).map(([name, incompleteAi]) => [period, name, incompleteAi] as const),
      ),
    )('rejects %s with %s before any outbound call', async (period, _name, incompleteAi) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { request, reportService, collectMock } = createReportService([log()]);

      await expect(
        reportService.generate({
          period,
          configs,
          runtime: { githubToken: 'test-token', ai: incompleteAi },
        }),
      ).rejects.toMatchObject({ status: 400 });

      expect(collectMock).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('trims AI configuration values before calling the client', async () => {
      const { request, reportService } = createReportService([log()]);
      request.mockResolvedValue('1. 新增周报生成');

      await reportService.generate({
        period: 'this-week',
        configs,
        runtime: {
          githubToken: 'test-token',
          ai: { baseUrl: ` ${ai.baseUrl} `, apiKey: ` ${ai.apiKey}\n`, model: `\t${ai.model} ` },
        },
      });

      expect(request.mock.calls[0][0]).toMatchObject({
        ...ai,
        temperature: 0.2,
        maxResponseBytes: 50_000,
        maxOutputCharacters: 50_000,
      });
      expect(request.mock.calls[0][0]).not.toHaveProperty('ai');
    });

    it.each(
      periods.flatMap((period) =>
        [
          new ProjectException('AI HTTP 请求失败（HTTP 500）。', 502),
          new ProjectException('AI 请求超时（30000ms）。', 504),
          new ProjectException('AI 配置不完整，需要 baseUrl、apiKey 和 model。', 400),
        ].map((error) => [period, error.getStatus(), error] as const),
      ),
    )('fails %s generation when the AI request rejects with %i', async (period, status, error) => {
      const { request, reportService } = createReportService([
        log({ subject: 'feat: 新增考试成绩查询' }),
      ]);
      request.mockRejectedValue(error);

      await expect(reportService.generate({ period, configs, runtime })).rejects.toMatchObject({
        status,
        message: error.message,
      });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each(
      periods.flatMap((period) =>
        (
          [
            ['English-only item', '1. 支持考试成绩查询\n2. update SQL scripts'],
            [
              'remainder placeholder',
              '1. 支持考试成绩公布\n2. 其余 5 条提交以细节调整和配套修改为主。',
            ],
            ['remaining placeholder', '1. 支持考试成绩公布\n2. 剩余 3 条工作为配套调整'],
            ['empty list', ''],
            ['heading only', '# 本周工作汇总'],
            ['placeholder only', '1. 无新增事项。'],
          ] as const
        ).map(([name, content]) => [period, name, content] as const),
      ),
    )('fails %s generation for an invalid AI summary: %s', async (period, _name, content) => {
      const { request, reportService } = createReportService([
        log({ subject: 'feat: 支持考试成绩查询' }),
        log({ subject: 'feat: 补充 SQL 脚本' }),
      ]);
      request.mockResolvedValue(content);

      await expect(reportService.generate({ period, configs, runtime })).rejects.toMatchObject({
        status: 502,
        message: 'AI 摘要内容无效，请重试或检查模型配置。',
      });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('fails the whole report when a later batch fails instead of filling it with titles', async () => {
      const logs = Array.from({ length: 5 }, (_, index) =>
        log({ subject: `新增考试功能 ${index + 1}` }),
      );
      const { request, reportService } = createReportService(logs);
      request
        .mockResolvedValueOnce('1. 支持考试自动阅卷\n2. 支持考试成绩公布')
        .mockRejectedValueOnce(new ProjectException('AI HTTP 请求失败（HTTP 503）。', 502));

      await expect(
        reportService.generate({
          period: 'this-week',
          configs,
          runtime: { ...runtime, limits: { maxPromptCommits: 2 } },
        }),
      ).rejects.toMatchObject({ status: 502, message: 'AI HTTP 请求失败（HTTP 503）。' });
      expect(request).toHaveBeenCalledTimes(2);
    });

    const budgetCases = [
      { name: 'one commit exceeds the budget', maxPromptCharacters: 5_000, bodyLength: 10_000 },
      { name: 'instructions alone exceed the budget', maxPromptCharacters: 1_000, bodyLength: 0 },
    ];

    it.each(
      periods.flatMap((period) => budgetCases.map((item) => [period, item.name, item] as const)),
    )('fails %s generation with 422 when %s', async (period, _name, item) => {
      const logs = [
        log({ subject: '保留超长考试说明', body: '丙'.repeat(item.bodyLength) }),
        log({ subject: '新增考试成绩查询' }),
      ];
      const { request, reportService } = createReportService(logs);
      // 与真实客户端一致：超出 prompt 预算时抛出 422，而不是返回内容。
      request.mockImplementation(async (options) => {
        expect(options.maxPromptCharacters).toBeDefined();
        if (options.prompt.length > options.maxPromptCharacters!) {
          throw new ProjectException(
            `AI prompt 超过长度限制（${options.maxPromptCharacters} 字符）。`,
            422,
          );
        }
        return echoSubjects(options.prompt);
      });

      await expect(
        reportService.generate({
          period,
          configs,
          runtime: { ...runtime, limits: { maxPromptCharacters: item.maxPromptCharacters } },
        }),
      ).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('AI prompt 超过长度限制'),
      });
    });

    it.each(periods)(
      'still isolates GitHub failures per project while AI succeeds for %s',
      async (period) => {
        const { reportService, collectMock } = createReportService([]);
        collectMock
          .mockRejectedValueOnce(new ProjectException('GitHub API error: 404', 404))
          .mockResolvedValueOnce([log({ subject: 'feat: 支持考试成绩查询' })]);

        const result = await reportService.generate({
          period,
          configs: [
            { repo: 'https://github.com/example/failed.git', person: 'one@example.com' },
            { repo: 'https://github.com/example/success.git', person: 'two@example.com' },
          ],
          runtime,
        });

        expect(result.projectErrors).toHaveLength(1);
        expect(result.projectErrors[0].code).toBe(404);
        expect(result.projects).toHaveLength(1);
        expect(result.degraded).toBe(false);
      },
    );

    it.each(periods)(
      'returns a no-commit %s report with complete AI configuration without calling the model',
      async (period) => {
        const { request, reportService } = createReportService([]);

        const result = await reportService.generate({ period, configs, runtime });

        expect(request).not.toHaveBeenCalled();
        expect(result.commitCount).toBe(0);
        expect(result.markdown).toContain('无提交。');
        expect(result.degraded).toBe(false);
      },
    );

    it('keeps cross-day deduplication in last-week reports without failing the duplicate day', async () => {
      const { request, reportService } = createReportService([
        log({ hash: 'day-1', subject: '新增考试成绩公布', date: '2026-04-06T12:00:00+08:00' }),
        log({ hash: 'day-2', subject: '调整考试成绩公布', date: '2026-04-07T12:00:00+08:00' }),
        log({ hash: 'day-3', subject: '补充打回答卷规则', date: '2026-04-08T12:00:00+08:00' }),
      ]);
      request
        .mockResolvedValueOnce('1. 支持考试成绩公布')
        .mockResolvedValueOnce('1. 支持考试成绩公布')
        .mockResolvedValueOnce('1. 支持考试成绩公布\n2. 支持打回答卷');

      const result = await reportService.generate({ period: 'last-week', configs, runtime });

      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2][0].prompt).toContain('支持考试成绩公布');
      expect(
        result.projects[0].bullets.filter(
          (bullet) => !['无提交。', '无新增事项。'].includes(bullet),
        ),
      ).toEqual(['支持考试成绩公布', '支持打回答卷']);
      expect(result.markdown.match(/支持考试成绩公布/g)).toHaveLength(1);
      expect(result.degraded).toBe(false);
    });
  });

  it.each(['last-week', 'this-week'] as const)(
    'filters commits before both counting and AI generation for %s',
    async (period) => {
      const aiClient = new AiTextClientService();
      const request = vi
        .spyOn(aiClient, 'generate')
        .mockResolvedValue(
          '1. 支持教师查看课堂笔记\n2. 支持学生查看课堂笔记\n3. 支持课堂笔记导出\n4. 补充课堂笔记使用说明',
        );
      const reportService = new WeeklyCommitReportService(aiClient);
      vi.spyOn(reportService, 'getLastWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService as unknown as CommitCollector, 'collectGitLogs').mockResolvedValue([
        log({ subject: '   ' }),
        log({ subject: 'feat: ' }),
        log({ subject: 'Merge branch feature/notes' }),
        log({ subject: 'rebase main' }),
        log({ subject: 'feat: add exam export', body: 'Support CSV export.', author: '张三' }),
        log({ subject: '12345', body: 'SQL API v1.12.0' }),
        log({ subject: 'feat: 完善课堂笔记', body: '增加教师查看权限' }),
        log({ subject: 'fix: 完善课堂笔记', body: '增加教师查看权限\r\n' }),
        log({ subject: 'feat: 完善课堂笔记', body: '增加学生查看权限' }),
        log({ subject: 'feat: add classroom note export', body: '支持课堂笔记导出' }),
        log({ subject: 'docs: 补充课堂笔记使用说明' }),
      ]);

      const result = await reportService.generate({
        period,
        configs: [{ repo: 'https://github.com/example/demo.git', person: 'person@example.com' }],
        runtime,
      });
      const commits = JSON.parse(
        request.mock.calls[0][0].prompt.split('\n').at(-1)!,
      ) as GitLogEntry[];

      expect(request).toHaveBeenCalledTimes(1);
      expect(result.commitCount).toBe(4);
      expect(result.projects[0].commitCount).toBe(4);
      expect(commits.map(({ subject, body }) => ({ subject, body }))).toEqual([
        { subject: '完善课堂笔记', body: '增加教师查看权限' },
        { subject: '完善课堂笔记', body: '增加学生查看权限' },
        { subject: 'add classroom note export', body: '支持课堂笔记导出' },
        { subject: '补充课堂笔记使用说明', body: '' },
      ]);
      expect(result.markdown).toContain('支持教师查看课堂笔记');
      expect(result.markdown).toContain('支持学生查看课堂笔记');
      expect(result.markdown).toMatch(/\p{Script=Han}/u);
      expect(result.projects[0].repo).toBe('https://github.com/example/demo.git');
    },
  );

  it.each(['last-week', 'this-week'] as const)(
    'skips AI generation when all %s commits are filtered out',
    async (period) => {
      const aiClient = new AiTextClientService();
      const request = vi.spyOn(aiClient, 'generate');
      const reportService = new WeeklyCommitReportService(aiClient);
      vi.spyOn(reportService, 'getLastWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService as unknown as CommitCollector, 'collectGitLogs').mockResolvedValue([
        log({ subject: 'feat: ' }),
        log({ subject: 'Merge branch feature/notes' }),
        log({ subject: 'update release artifacts for 1.12.0', body: 'Publish the release.' }),
      ]);

      const result = await reportService.generate({
        period,
        configs: [{ repo: 'https://github.com/example/demo.git', person: 'person@example.com' }],
        runtime,
      });

      expect(request).not.toHaveBeenCalled();
      expect(result.commitCount).toBe(0);
      expect(result.markdown).toContain('无提交。');
      expect(result.markdown).toMatch(/\p{Script=Han}/u);
      expect(result.degraded).toBe(false);
    },
  );

  it.each(['SQL', 'API', 'AI', 'v1.12.0', 'ＡＩ', 'école'])(
    'accepts AI output containing Chinese and %s',
    async (term) => {
      const aiClient = new AiTextClientService();
      vi.spyOn(aiClient, 'generate').mockResolvedValue(`1. 支持考试成绩查询 ${term}`);
      const reportService = new WeeklyCommitReportService(aiClient);
      vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService as unknown as CommitCollector, 'collectGitLogs').mockResolvedValue([
        log({ subject: 'feat: 支持考试成绩查询' }),
        log({ subject: 'fix: 修复考试成绩排序' }),
      ]);

      const result = await reportService.generate({
        period: 'this-week',
        configs: [{ repo: 'https://github.com/example/demo.git', person: 'person@example.com' }],
        runtime,
      });

      expect(result.projects[0].bullets).toEqual([`支持考试成绩查询 ${term}`]);
      expect(result.markdown).toContain(`支持考试成绩查询 ${term}`);
      expect(result.degraded).toBe(false);
    },
  );

  it.each(['last-week', 'this-week'] as const)(
    'sends the complete Chinese-containing body to AI when the %s title has no Chinese',
    async (period) => {
      const aiClient = new AiTextClientService();
      const request = vi
        .spyOn(aiClient, 'generate')
        .mockResolvedValue(
          '1. 补充课堂笔记 SQL 脚本，新增导出 API，支持 v1.12.0\n2. 支持 AI 考试评分',
        );
      const reportService = new WeeklyCommitReportService(aiClient);
      vi.spyOn(reportService, 'getLastWeekWindow').mockReturnValue(window);
      vi.spyOn(reportService, 'getThisWeekWindow').mockReturnValue(window);
      const body = '补充课堂笔记 SQL 脚本\n\n新增导出 API，支持 v1.12.0';
      vi.spyOn(reportService as unknown as CommitCollector, 'collectGitLogs').mockResolvedValue([
        log({ subject: 'feat: add classroom note export', body }),
        log({ subject: 'feat: 支持 AI 考试评分' }),
        log({ subject: 'update release artifacts for 1.12.0' }),
      ]);

      const result = await reportService.generate({
        period,
        configs: [{ repo: 'https://github.com/example/demo.git', person: 'person@example.com' }],
        runtime,
      });
      const commits = JSON.parse(
        request.mock.calls[0][0].prompt.split('\n').at(-1)!,
      ) as GitLogEntry[];

      expect(request).toHaveBeenCalledTimes(1);
      expect(commits.map((entry) => entry.body)).toEqual([body, '']);
      expect(result.commitCount).toBe(2);
      expect(
        result.projects[0].bullets.filter(
          (bullet) => !['无提交。', '无新增事项。'].includes(bullet),
        ),
      ).toEqual(['补充课堂笔记 SQL 脚本，新增导出 API，支持 v1.12.0', '支持 AI 考试评分']);
      expect(result.markdown).toContain('新增导出 API，支持 v1.12.0');
      expect(result.markdown).not.toContain('update release artifacts');
      expect(result.degraded).toBe(false);
    },
  );

  it('retains Chinese names in the report without translating raw identifiers', () => {
    const markdown = service.renderLastWeekReport({
      person: '张三',
      weekStart: '2026-04-06',
      weekEnd: '2026-04-12',
      projects: [{ repo: 'https://github.com/example/demo.git', person: '张三', branch: 'main' }],
      sections: [{ date: '2026-04-06', logs: [], bullets: ['完成周报菜单'] }],
    });

    expect(markdown).toContain('# 张三 上周任务日志');
    expect(markdown).toContain('- 人员：张三');
    expect(markdown).toMatch(/\p{Script=Han}/u);
  });

  it('renders the migrated last-week and this-week report formats', () => {
    const projects = [
      {
        repo: 'https://github.com/example/demo.git',
        repoLabel: 'demo',
        person: 'ljh',
        branch: 'main',
        commitCount: 2,
        bullets: ['完成周报菜单'],
      },
    ];
    const lastWeek = service.renderLastWeekReport({
      person: 'ljh',
      weekStart: '2026-04-06',
      weekEnd: '2026-04-12',
      projects,
      sections: [{ date: '2026-04-06', logs: [], bullets: ['完成周报菜单'] }],
    });
    const thisWeek = service.renderThisWeekReport({
      person: 'ljh',
      weekStart: '2026-04-13',
      weekEnd: '2026-04-17',
      projects,
    });

    expect(lastWeek).toContain('# ljh 上周任务日志');
    expect(lastWeek).toContain('## 2026-04-06（星期一）');
    expect(lastWeek).toContain('- 来源：demo@main');
    expect(thisWeek).toContain('# ljh 本周项目提交汇总');
    expect(thisWeek).toContain('## 本周摘要（去重）');
    expect(thisWeek).toContain('## 项目：demo');
    expect(thisWeek).toContain('- 仓库：https://github.com/example/demo.git');
    expect(thisWeek).toContain('- 分支：main');
    expect(thisWeek).toContain('- 提交数量：2');
    expect(lastWeek).toMatch(/\p{Script=Han}/u);
    expect(thisWeek).toMatch(/\p{Script=Han}/u);
  });
});
