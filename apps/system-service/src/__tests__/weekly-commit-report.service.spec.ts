import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectException } from '@nest-cloud/common';
import { WeeklyCommitReportService } from '../modules/weekly-commit-report/weekly-commit-report.service';
import type {
  GitLogEntry,
  WeekWindow,
  WeeklyReportProjectConfig,
} from '../modules/weekly-commit-report/weekly-report.types';

const service = new WeeklyCommitReportService();
const runtime = { githubToken: 'test-token' };

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
  subject: 'feat: add weekly report',
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
      .mockResolvedValueOnce([log({ hash: 'success-a', subject: 'feat: success a' })])
      .mockResolvedValueOnce([log({ hash: 'success-b', subject: 'fix: success b' })]);

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
    expect(result.markdown).toContain('failed（404）');
    expect(result.markdown).toContain('success-a');
    expect(result.markdown).toContain('success-b');
  });

  it('skips a failed project from last-week Sources', async () => {
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
    expect(result.markdown).toContain('- Sources: success@main');
    expect(result.markdown).not.toContain('failed@main');
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

  it('strips conventional prefixes and filters integration commits in local fallback', () => {
    const bullets = service.buildLocalSummary([
      log({ subject: 'feat: add dashboard' }),
      log({ subject: 'add dashboard' }),
      log({ subject: 'Merge branch feature/report' }),
      log({ subject: 'fix: repair export' }),
    ]);

    expect(bullets).toEqual([
      'add dashboard',
      'repair export',
      '其余 2 条提交以细节调整和配套修改为主。',
    ]);
  });

  it('distributes unique report bullets across workdays', () => {
    const sections = service.distributeBulletsAcrossDays(
      ['one', 'two', 'two', 'three'],
      ['2026-04-06', '2026-04-07'],
    );

    expect(sections.map((section) => section.bullets)).toEqual([['one', 'two'], ['three']]);
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
    expect(thisWeek).toContain('# ljh 本周项目提交汇总');
    expect(thisWeek).toContain('## 本周摘要（去重）');
    expect(thisWeek).toContain('- Commits: 2');
  });
});
