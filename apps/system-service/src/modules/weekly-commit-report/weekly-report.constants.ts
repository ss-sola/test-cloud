import type { WeeklyReportProjectConfig } from './weekly-report.types';

/** 周报模块私有配置键，不扩散到 common-service。 */
export const WeeklyReportConfigKeys = {
  AllowedRepositories: 'WeeklyReportAllowedRepositories',
  AllowedLocalRoot: 'WeeklyReportAllowedLocalRoot',
  AiBaseUrl: 'WeeklyReportAiBaseUrl',
  AiApiKey: 'WeeklyReportAiApiKey',
  AiModel: 'WeeklyReportAiModel',
  CommandTimeoutMs: 'WeeklyReportCommandTimeoutMs',
  AiTimeoutMs: 'WeeklyReportAiTimeoutMs',
  MaxProjects: 'WeeklyReportMaxProjects',
  MaxCommits: 'WeeklyReportMaxCommits',
  MaxPromptCommits: 'WeeklyReportMaxPromptCommits',
  MaxPromptCharacters: 'WeeklyReportMaxPromptCharacters',
  MaxOutputCharacters: 'WeeklyReportMaxOutputCharacters',
} as const;

export const DEFAULT_WEEKLY_REPORT_PROJECTS: WeeklyReportProjectConfig[] = [
  {
    repo: 'https://github.com/whtthd/wzj-nodejs-v2.git',
    person: 'ljh',
    branch: 'merge/wzj-temp',
  },
  {
    repo: 'https://github.com/whtthd/resource-portal-and-manage-backend.git',
    person: 'ljh',
    branch: 'dev/master',
  },
  {
    repo: 'https://github.com/whtthd/wzj-pc-frontend-next.git',
    person: 'ljh',
    branch: 'publish/integration',
  },
];
