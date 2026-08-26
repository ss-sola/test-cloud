export type WeeklyReportPeriod = 'last-week' | 'this-week';

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

export interface WeeklyReportResult {
  period: WeeklyReportPeriod;
  weekStart: string;
  weekEnd: string;
  markdown: string;
  projects: WeeklyReportProjectResult[];
  commitCount: number;
  degraded: boolean;
}

export interface GenerateWeeklyReportInput {
  period: WeeklyReportPeriod;
  configs?: WeeklyReportProjectConfig[];
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
