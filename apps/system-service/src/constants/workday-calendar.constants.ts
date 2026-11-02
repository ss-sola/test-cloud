/** 联网工作日日历的数据源、预算与校验规则；客户端、能力 Service 与 DTO 共用同一组数值。 */
export const WORKDAY_CALENDAR_REGION = 'CN';

/** 民用日期按该时区口径输出；星期由 UTC 民用日期计算，不依赖服务端本地时区。 */
export const WORKDAY_CALENDAR_TIME_ZONE = 'Asia/Shanghai';

/** 第三方整理的国务院放假通知年度数据（不是政府官方 API），仅按年度固定路径读取。 */
export const WORKDAY_CALENDAR_SOURCE_BASE_URL =
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/';

export const WORKDAY_CALENDAR_SOURCE_FILE_SUFFIX = '.json';

export const WORKDAY_CALENDAR_DAY_MS = 24 * 60 * 60 * 1000;

export const WORKDAY_CALENDAR_LIMITS = Object.freeze({
  /** 查询区间首尾包含的最大天数。 */
  maxRangeDays: 366,
  /** 单次查询最多读取的年度文件数。 */
  maxYears: 3,
  /** 单个年度文件请求时限。 */
  requestTimeoutMs: 15_000,
  /** 一次查询所有年度文件的总时限。 */
  totalTimeoutMs: 45_000,
  maxResponseBytes: 256 * 1024,
  /** 本能力接受的年度读取范围。 */
  minYear: 2007,
  maxYear: 2100,
  /** 单个年度文件允许的覆盖项数量。 */
  maxOverridesPerYear: 400,
  maxPapers: 20,
  maxPaperUrlLength: 512,
  maxNameLength: 64,
  /** 覆盖项日期允许相对数据年份前后偏移的年数（通知可能覆盖相邻年度的边界日期）。 */
  maxYearOffset: 1,
});

export const WORKDAY_CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 政府通知链接：HTTPS、精确 www.gov.cn、无账号密码、端口与 fragment，只允许可见 ASCII。 */
export const WORKDAY_CALENDAR_PAPER_URL_PATTERN =
  /^https:\/\/www\.gov\.cn(?:[/?][\x21\x22\x24-\x7E]*)?$/;

/** 节假日名称：非空白、无 Unicode 控制字符。 */
export const WORKDAY_CALENDAR_NAME_PATTERN = /^(?=.*\S)\P{Cc}+$/u;

export const WORKDAY_CALENDAR_REASONS = Object.freeze({
  weekday: 'weekday',
  weekend: 'weekend',
  holiday: 'holiday',
  makeupWorkday: 'makeup-workday',
} as const);

/** 对调用方输出的固定文案；不包含请求原文、上游正文或凭据。 */
export const WORKDAY_CALENDAR_MESSAGES = Object.freeze({
  invalidRegion: 'region 仅支持 CN（中国大陆）。',
  invalidDate: 'startDate/endDate 必须是有效的 YYYY-MM-DD 日期。',
  invalidRange: 'endDate 不能早于 startDate。',
  rangeTooLarge: `日期跨度不能超过 ${WORKDAY_CALENDAR_LIMITS.maxRangeDays} 天。`,
  yearUnsupported: `仅支持 ${WORKDAY_CALENDAR_LIMITS.minYear}-${WORKDAY_CALENDAR_LIMITS.maxYear} 年的日历数据。`,
  tooManyYears: `一次查询最多读取 ${WORKDAY_CALENDAR_LIMITS.maxYears} 个年度的日历数据。`,
  notPublished: '该年度的节假日安排尚未发布或数据源缺失，已拒绝猜测工作日。',
  invalidData: '日历数据源返回的数据格式无效。',
  unreachable: '日历数据源暂时无法访问。',
  timeout: '外部服务请求超时。',
  cancelled: '请求已取消。',
});
