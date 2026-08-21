/**
 * 全局配置键常量。
 * 所有 getConfig() 的第一个参数必须引用此处的常量，禁止使用内联字符串字面量。
 */
export const ConfigKeys = {
  // ── 服务标识 ────────────────────────────────────────────────────────
  ServiceHost: 'ServiceHost',
  /** 服务的逻辑名称（用于注册中心、日志等） */
  ServiceName: 'ServiceName',
  /** 服务监听端口 */
  Port: 'Port',
  /** 可选的全局路由前缀 */
  GlobalPrefix: 'GlobalPrefix',
  /** 可选的路由扫描模式，传给 register() */
  Pattern: 'Pattern',

  // ── 注册中心 & 远程配置 ──────────────────────────────────────────────
  /** 注册中心 / 配置中心服务器的基础 URL */
  RegistryUrl: 'RegistryUrl',
  /** 启动时拉取的远程配置文件名，多个以逗号分隔 */
  ConfigNames: 'ConfigNames',
  /** 向注册中心广播的任意元数据对象 */
  ServiceMetadata: 'ServiceMetadata',
  /** 心跳间隔（毫秒） */
  HeartbeatInterval: 'HeartbeatInterval',
  /** 服务列表同步间隔（毫秒） */
  SyncInterval: 'SyncInterval',

  // ── 数据库 ──────────────────────────────────────────────────────────
  DbDriver: 'DbDriver',
  DbHost: 'DbHost',
  DbPort: 'DbPort',
  DbUsername: 'DbUsername',
  DbPassword: 'DbPassword',
  DbDatabase: 'DbDatabase',
  /** 是否允许 TypeORM 自动同步实体结构（仅限开发环境） */
  DbSynchronize: 'DbSynchronize',

  // ── Session ──────────────────────────────────────────────────────────
  /** Redis 连接 URL，不配则降级为内存存储 */
  SessionRedisUrl: 'SessionRedisUrl',
  /** Session 签名密钥（必填，否则不启用 session） */
  SessionSecret: 'SessionSecret',
  /** Cookie 名称，默认 'system.sid' */
  SessionCookieName: 'SessionCookieName',
  /** 会话有效期（毫秒），默认 8 小时 */
  SessionTtlMs: 'SessionTtlMs',
  /** Redis key 前缀，默认 'system-session' */
  SessionKeyPrefix: 'SessionKeyPrefix',
  /** SameSite 策略，默认 'lax' */
  SessionSameSite: 'SessionSameSite',
  /** 是否启用 HTTPS-only cookie，默认 false */
  SessionSecure: 'SessionSecure',

  // ── 日志 ────────────────────────────────────────────────────────────
  /** 控制台日志传输的最低级别（如 'info'、'debug'） */
  ConsoleLogLevel: 'ConsoleLogLevel',
  /** 运行环境；为 'production' 时关闭控制台日志 */
  NodeEnv: 'NodeEnv',
} as const;

export type ConfigKeyName = (typeof ConfigKeys)[keyof typeof ConfigKeys];
