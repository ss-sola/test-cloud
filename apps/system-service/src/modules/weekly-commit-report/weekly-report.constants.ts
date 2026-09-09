export const WEEKLY_REPORT_JOB_TTL_MS = 30 * 60 * 1000;
export const WEEKLY_REPORT_MAX_ACTIVE_JOBS = 2;
export const WEEKLY_REPORT_WORKER_CONCURRENCY = WEEKLY_REPORT_MAX_ACTIVE_JOBS;
export const WEEKLY_REPORT_QUEUE_NAME = 'weekly-report';
export const WEEKLY_REPORT_QUEUE_PREFIX = 'bull';
export const WEEKLY_REPORT_QUEUE_JOB_NAME = 'generate';
export const WEEKLY_REPORT_POLL_INTERVAL_MS = 800;

export const FEISHU_OPEN_API_BASE_URL = 'https://open.feishu.cn';
export const DEFAULT_FEISHU_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_FEISHU_MAX_RETRIES = 2;
export const FEISHU_RETRY_BASE_DELAY_MS = 250;
export const FEISHU_TOKEN_REFRESH_SKEW_MS = 60_000;
export const FEISHU_WEEKDAY_COLUMNS = ['C', 'D', 'E', 'F', 'G'] as const;
/** 周报发布固定只读的日期/姓名查找范围。 */
export const FEISHU_DEFAULT_LOOKUP_RANGE = 'A1:B200';
export const FEISHU_MAX_CELL_CHARACTERS = 8_000;
