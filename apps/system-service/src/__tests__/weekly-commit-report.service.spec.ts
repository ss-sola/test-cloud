import { describe, expect, it } from 'vitest';
import { WeeklyCommitReportService } from '../modules/weekly-commit-report/weekly-commit-report.service';

const service = new WeeklyCommitReportService();

const log = (overrides: Partial<{
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
}> = {}) => ({
  hash: 'abc123',
  author: 'ljh',
  date: '2026-04-07T09:00:00+08:00',
  subject: 'feat: add weekly report',
  body: '',
  ...overrides,
});

describe('WeeklyCommitReportService', () => {
  it('calculates the previous complete Monday-to-Sunday window', () => {
    const window = service.getLastWeekWindow(new Date('2026-04-17T12:00:00+08:00'));

    expect(window.dayKeys).toEqual([
      '2026-04-06',
      '2026-04-07',
      '2026-04-08',
      '2026-04-09',
      '2026-04-10',
      '2026-04-11',
      '2026-04-12',
    ]);
    expect(window.start.getHours()).toBe(0);
    expect(window.end.getHours()).toBe(0);
  });

  it('calculates the current week through today', () => {
    const window = service.getThisWeekWindow(new Date('2026-04-17T12:00:00+08:00'));

    expect(window.dayKeys).toEqual([
      '2026-04-13',
      '2026-04-14',
      '2026-04-15',
      '2026-04-16',
      '2026-04-17',
    ]);
    expect(window.end.toISOString()).toBe('2026-04-17T04:00:00.000Z');
  });

  it('builds git arguments without shell interpolation', () => {
    const args = service.buildGitLogArgs({
      repoPath: 'C:\\repositories\\demo',
      ref: 'refs/heads/main',
      since: new Date('2026-04-06T00:00:00+08:00'),
      until: new Date('2026-04-13T00:00:00+08:00'),
      person: 'a.*(test)',
    });

    expect(args).toContain('--no-merges');
    expect(args).toContain('--author=a\\.\\*\\(test\\)');
    expect(args).toContain('refs/heads/main');
    expect(args.some((arg) => arg.includes('&&'))).toBe(false);
  });

  it('parses and groups git log records by local date', () => {
    const raw = [
      log({ hash: 'one', date: '2026-04-07T09:00:00+08:00', subject: 'fix: first' }),
      log({ hash: 'two', date: '2026-04-08T09:00:00+08:00', subject: 'docs: second' }),
    ]
      .map((entry) => [entry.hash, entry.author, entry.date, entry.subject, entry.body].join('\u001f'))
      .join('\u001e');

    const parsed = service.parseGitLogOutput(raw);
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

    expect(sections.map((section) => section.bullets)).toEqual([
      ['one', 'two'],
      ['three'],
    ]);
  });

  it('renders the migrated last-week and this-week report formats', () => {
    const projects = [{
      repo: 'https://github.com/example/demo.git',
      repoLabel: 'demo',
      person: 'ljh',
      branch: 'main',
      commitCount: 2,
      bullets: ['完成周报菜单'],
    }];
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
