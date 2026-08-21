import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import session = require('express-session');

const REDIS_SESSION_COMMAND_TIMEOUT_MS = 3000;

export type RedisSessionOptions = {
  /** express-session cookie 签名密钥 */
  secret: string;
  /** Cookie 名称，默认 'connect.sid' */
  cookieName?: string;
  /** Redis key 前缀，默认 'session' */
  keyPrefix?: string;
  /** 会话有效期（毫秒） */
  ttlMs: number;
  /** 是否启用 HTTPS-only cookie */
  secure?: boolean;
  /** SameSite 策略，接受原始配置值，非法值降级为 'lax' */
  sameSite?: unknown;
  /** Redis 连接 URL，不传则降级为 MemoryStore */
  redisUrl?: string;
};

/** ioredis 支持的 Redis session store，实现 express-session Store 接口。 */
export class RedisSessionStore extends session.Store {
  private readonly logger = new Logger(RedisSessionStore.name);
  private readonly client: Redis;

  constructor(
    private readonly options: {
      redisUrl: string;
      keyPrefix: string;
      ttlMs: number;
    },
  ) {
    super();
    this.client = new Redis(options.redisUrl, {
      commandTimeout: REDIS_SESSION_COMMAND_TIMEOUT_MS,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
    this.client.on('error', (error: unknown) => {
      this.logger.error(
        `Redis session error: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    });
  }

  override get(
    sid: string,
    callback: (error?: unknown, sessionData?: session.SessionData | null) => void,
  ) {
    this.client
      .get(this.toKey(sid))
      .then((payload) => {
        if (!payload) {
          callback(undefined, null);
          return;
        }
        callback(undefined, JSON.parse(payload) as session.SessionData);
      })
      .catch((error: unknown) => callback(error));
  }

  override set(
    sid: string,
    sessionData: session.SessionData,
    callback?: (error?: unknown) => void,
  ) {
    this.client
      .set(this.toKey(sid), JSON.stringify(sessionData), 'PX', this.resolveTtlMs(sessionData))
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  override destroy(sid: string, callback?: (error?: unknown) => void) {
    this.client
      .del(this.toKey(sid))
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  override touch(sid: string, sessionData: session.SessionData, callback?: () => void) {
    this.client
      .pexpire(this.toKey(sid), this.resolveTtlMs(sessionData))
      .then(() => callback?.())
      .catch(() => callback?.());
  }

  /** 暴露 Redis 客户端，供 session 管理服务使用 */
  getRedisClient(): Redis {
    return this.client;
  }

  /** 获取 key 前缀 */
  getKeyPrefix(): string {
    return this.options.keyPrefix;
  }

  /**
   * 更新指定账户的所有 session 中的 permissionCodes。
   * 使用 SCAN 遍历所有 session key，逐个检查 accountId 是否匹配。
   * @returns 更新的 session 数量
   */
  async updateAccountPermissions(accountId: number, permissionCodes: string[]): Promise<number> {
    const pattern = `${this.options.keyPrefix}:*`;
    let cursor = '0';
    let updatedCount = 0;

    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const payload = await this.client.get(key);
        if (!payload) continue;
        try {
          const data = JSON.parse(payload) as session.SessionData;
          const account = (data as unknown as Record<string, unknown>).account as
            | { accountId?: number }
            | undefined;
          if (account?.accountId === accountId) {
            (account as unknown as Record<string, unknown>).permissionCodes = permissionCodes;
            const ttl = await this.client.pttl(key);
            const effectiveTtl = ttl > 0 ? ttl : this.options.ttlMs;
            await this.client.set(key, JSON.stringify(data), 'PX', effectiveTtl);
            updatedCount++;
          }
        } catch {
          // 跳过解析失败的 session
        }
      }
    } while (cursor !== '0');

    return updatedCount;
  }

  /**
   * 批量更新多个账户的 session 中的 permissionCodes。
   * @param updates Map<accountId, permissionCodes>
   * @returns 更新的 session 数量
   */
  async updateMultipleAccountsPermissions(updates: Map<number, string[]>): Promise<number> {
    if (updates.size === 0) return 0;
    const pattern = `${this.options.keyPrefix}:*`;
    let cursor = '0';
    let updatedCount = 0;

    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const payload = await this.client.get(key);
        if (!payload) continue;
        try {
          const data = JSON.parse(payload) as session.SessionData;
          const account = (data as unknown as Record<string, unknown>).account as
            | { accountId?: number }
            | undefined;
          if (account?.accountId && updates.has(account.accountId)) {
            (account as unknown as Record<string, unknown>).permissionCodes = updates.get(
              account.accountId,
            );
            const ttl = await this.client.pttl(key);
            const effectiveTtl = ttl > 0 ? ttl : this.options.ttlMs;
            await this.client.set(key, JSON.stringify(data), 'PX', effectiveTtl);
            updatedCount++;
          }
        } catch {
          // 跳过解析失败的 session
        }
      }
    } while (cursor !== '0');

    return updatedCount;
  }

  private toKey(sid: string) {
    return `${this.options.keyPrefix}:${sid}`;
  }

  private resolveTtlMs(sessionData: session.SessionData) {
    const cookieMaxAge = sessionData.cookie?.maxAge;
    return typeof cookieMaxAge === 'number' && cookieMaxAge > 0 ? cookieMaxAge : this.options.ttlMs;
  }
}

function parseSameSite(value: unknown): 'lax' | 'strict' | 'none' | boolean {
  if (typeof value === 'boolean') return value;
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'lax' || normalized === 'strict' || normalized === 'none') {
    return normalized;
  }
  return 'lax';
}

/**
 * 创建 express-session 中间件。
 * 当 redisUrl 存在时使用 Redis 存储，否则降级为内存存储。
 */
export function createRedisSession(options: RedisSessionOptions): ReturnType<typeof session> {
  const store = options.redisUrl
    ? new RedisSessionStore({
        redisUrl: options.redisUrl,
        keyPrefix: options.keyPrefix ?? 'session',
        ttlMs: options.ttlMs,
      })
    : new session.MemoryStore();

  return session({
    name: options.cookieName,
    secret: options.secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store,
    cookie: {
      httpOnly: true,
      sameSite: parseSameSite(options.sameSite),
      secure: options.secure ?? false,
      maxAge: options.ttlMs,
      path: '/',
    },
  });
}
