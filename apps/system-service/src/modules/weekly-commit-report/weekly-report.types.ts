export type WeeklyReportPeriod = 'last-week' | 'this-week';

export type WeeklyReportJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type WeeklyReportProgressPhase =
  | 'queued'
  | 'validating'
  | 'collecting'
  | 'summarizing'
  | 'finalizing'
  | 'publishing'
  | 'completed'
  | 'failed';

export interface WeeklyReportProgress {
  phase: WeeklyReportProgressPhase;
  percent: number;
  completedProjects: number;
  totalProjects: number;
  failedProjects: number;
  currentProject: string | null;
  message: string;
}

export type WeeklyReportProgressReporter = (progress: WeeklyReportProgress) => void;

export interface WeeklyReportJobError {
  code: number;
  message: string;
}

export interface WeeklyReportProjectConfig {
  repo: string;
  person: string;
  branch?: string;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
}

export interface WeekWindow {
  start: Date;
  end: Date;
  dayKeys: string[];
}

export interface DailyReportSection {
  date: string;
  logs: GitLogEntry[];
  bullets: string[];
}

export interface WeeklyReportProjectResult {
  repo: string;
  repoLabel: string;
  person: string;
  branch: string;
  commitCount: number;
  bullets: string[];
}

export interface WeeklyReportProjectError {
  repo: string;
  repoLabel: string;
  code: number;
  message: string;
}

export interface WeeklyReportResult {
  period: WeeklyReportPeriod;
  weekStart: string;
  weekEnd: string;
  markdown: string;
  projects: WeeklyReportProjectResult[];
  projectErrors: WeeklyReportProjectError[];
  commitCount: number;
  degraded: boolean;
  /** 上周日报的工作日摘要，用于按列写入飞书 Sheet。 */
  dailySections?: DailyReportSection[];
}

export interface WeeklyReportPublishSettingsInput {
  appId: string;
  appSecret: string;
  wikiUrl: string;
  name?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

export interface WeeklyReportPublishInput {
  enabled?: boolean;
  /** 表格 B 列中的姓名；不传时仅允许从单一项目人员推断。 */
  person?: string;
  settings?: WeeklyReportPublishSettingsInput;
}

export interface WeeklyReportRuntimeConfig {
  githubToken: string;
  allowedRepositories?: string[];
  ai?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  limits?: Partial<WeeklyReportLimits>;
}

export interface GenerateWeeklyReportInput {
  period: WeeklyReportPeriod;
  configs: WeeklyReportProjectConfig[];
  runtime: WeeklyReportRuntimeConfig;
  publish?: WeeklyReportPublishInput;
}

export type WeeklyReportPublicationStatus =
  | 'not-requested'
  | 'validating'
  | 'skipped'
  | 'succeeded'
  | 'failed';

export interface WeeklyReportPublicationResult {
  status: Exclude<WeeklyReportPublicationStatus, 'not-requested' | 'validating'>;
  range?: string;
  row?: number;
  retryable?: boolean;
  message?: string;
}

export interface WeeklyReportJobView {
  jobId: string;
  status: WeeklyReportJobStatus;
  progress: WeeklyReportProgress;
  result: WeeklyReportResult | null;
  publication: WeeklyReportPublicationResult | null;
  error: WeeklyReportJobError | null;
}

export interface WeeklyReportJobCreateResult {
  jobId: string;
  status: WeeklyReportJobStatus;
  progress: WeeklyReportProgress;
}

export interface WeeklyReportLimits {
  maxProjects: number;
  maxCommitsPerRepository: number;
  maxPromptCommits: number;
  maxPromptCharacters: number;
  maxOutputCharacters: number;
  commandTimeoutMs: number;
  aiTimeoutMs: number;
}
