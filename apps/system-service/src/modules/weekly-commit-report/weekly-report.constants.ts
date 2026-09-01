import type { WeeklyReportProjectConfig } from './weekly-report.types';

/** 周报模块私有配置键，不扩散到 common-service。 */
export const WeeklyReportConfigKeys = {
  AllowedRepositories: 'WeeklyReportAllowedRepositories',
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
  FeishuPublishEnabled: 'WeeklyReportFeishuPublishEnabled',
  FeishuAppId: 'WeeklyReportFeishuAppId',
  FeishuAppSecret: 'WeeklyReportFeishuAppSecret',
  FeishuMonthlyTargets: 'WeeklyReportFeishuMonthlyTargets',
  FeishuRequestTimeoutMs: 'WeeklyReportFeishuRequestTimeoutMs',
  FeishuMaxRetries: 'WeeklyReportFeishuMaxRetries',
} as const;

export const WEEKLY_REPORT_JOB_TTL_MS = 30 * 60 * 1000;
export const WEEKLY_REPORT_MAX_ACTIVE_JOBS = 2;
export const WEEKLY_REPORT_POLL_INTERVAL_MS = 800;

export const FEISHU_OPEN_API_BASE_URL = 'https://open.feishu.cn';
export const DEFAULT_FEISHU_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_FEISHU_MAX_RETRIES = 2;
export const FEISHU_RETRY_BASE_DELAY_MS = 250;
export const FEISHU_TOKEN_REFRESH_SKEW_MS = 60_000;
export const FEISHU_WEEKDAY_COLUMNS = ['C', 'D', 'E', 'F', 'G'] as const;
export const FEISHU_DEFAULT_LOOKUP_RANGE = 'A1:B200';
export const FEISHU_MAX_MONTHLY_TARGETS = 24;
export const FEISHU_MAX_CELL_CHARACTERS = 8_000;

export const DEFAULT_WEEKLY_REPORT_PROJECTS: WeeklyReportProjectConfig[] = [
  {
    repo: 'https://github.com/whtthd/wzj-nodejs-v2.git',
    person: '2451477516@qq.com',
    branch: 'merge/wzj-temp',
  },
  {
    repo: 'https://github.com/whtthd/resource-portal-and-manage-backend.git',
    person: '2451477516@qq.com',
    branch: 'dev/master',
  },
  {
    repo: 'https://github.com/whtthd/wzj-pc-frontend-next.git',
    person: '2451477516@qq.com',
    branch: 'publish/integration',
  },
];
