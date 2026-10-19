export const WEEKLY_REPORT_JOB_TTL_MS = 30 * 60 * 1000;
export const WEEKLY_REPORT_MAX_ACTIVE_JOBS = 2;
export const WEEKLY_REPORT_WORKER_CONCURRENCY = WEEKLY_REPORT_MAX_ACTIVE_JOBS;
export const WEEKLY_REPORT_QUEUE_NAME = 'weekly-report';
export const WEEKLY_REPORT_QUEUE_PREFIX = 'bull';
export const WEEKLY_REPORT_QUEUE_JOB_NAME = 'generate';
export const WEEKLY_REPORT_POLL_INTERVAL_MS = 800;
export const WEEKLY_REPORT_CHINESE_PATTERN = /\p{Script=Han}/u;

export const WEEKLY_REPORT_WRITING_RULES = [
  '完整列出提交记录中有依据的独立工作事项，条数由实际内容决定，不设置条数目标或固定字数上限，不为凑条数编造、重复或省略。',
  '每条必须具有业务含义，写清“业务对象 + 具体变更”，有依据时再说明作用或结果；保留关键条件、适用范围和行为变化，不写只有“优化、调整、完善”的空泛描述。',
  '每条工作事项只要包含中文即可，允许中英混写，可保留 SQL、API、AI 等术语、必要标识符及 v1.12.0 等版本号；不要输出完全不含中文的事项，不要原样照抄缺少业务说明的提交标题。',
  '一条提交包含多个独立业务事项时逐条拆开；不同任务、业务对象、条件或结果不得合并。只有完全重复的工作成果可去重，同一任务的不同实质变更仍须分别列出。',
  '不得折叠内容或使用“其余 N 条提交”“剩余事项”“工作未展开”“细节调整和配套修改为主”等省略句，也不得用“完成若干优化”“其他调整”等兜底条目代替具体事项。',
  '发布类事项也要写清交付对象：分别描述版本发布产物、配置排除范围、数据库脚本、学校环境配置或实际版本发布，不能将不同交付笼统归为“发布相关调整”。',
  '只依据当前提交标题与完整正文，不从仓库名、版本号或表达示例推测功能、上线状态、验证结果或业务收益；细节不足时仅陈述可以确认的动作与对象，不得虚构业务价值。',
  '忽略分支合并、代码合入、merge、rebase、cherry-pick、PR/MR 同步及解决合并冲突等纯代码集成事项。',
  '以下仅为措辞示例，不是本次工作事实；<版本> 必须替换为当前记录中的实际版本：',
  'update release artifacts for <版本> → 更新 <版本> 版本发布产物。',
  'exclude classroom note configs from <版本> → 从 <版本> 发布配置中排除课堂笔记相关配置。',
  'release: release version <版本> → 发布 <版本> 版本。',
  'add data platform SQL and school release env for <版本> → 两条独立事项：补充 <版本> 数据平台数据库脚本；补充 <版本> 学校发布环境配置。',
] as const;

export const FEISHU_OPEN_API_BASE_URL = 'https://open.feishu.cn';
export const DEFAULT_FEISHU_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_FEISHU_MAX_RETRIES = 2;
export const FEISHU_RETRY_BASE_DELAY_MS = 250;
export const FEISHU_TOKEN_REFRESH_SKEW_MS = 60_000;
export const FEISHU_WEEKDAY_COLUMNS = ['C', 'D', 'E', 'F', 'G'] as const;
/** 周报发布固定只读的日期/姓名查找范围。 */
export const FEISHU_DEFAULT_LOOKUP_RANGE = 'A1:B200';
export const FEISHU_MAX_CELL_CHARACTERS = 8_000;
