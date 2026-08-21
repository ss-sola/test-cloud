/**
 * 跨服务共享登录态的默认配置。
 * 这些默认值必须与 system-service 保持一致，才能复用同一浏览器登录态。
 */
export const SHARED_AUTH_SESSION_COOKIE_NAME = 'system.sid';
export const SHARED_AUTH_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SHARED_AUTH_SESSION_KEY_PREFIX = 'system-session';
export const SHARED_AUTH_SESSION_SAME_SITE = 'lax';
export const SHARED_AUTH_SESSION_SECURE = false;

/** Redis 连接地址，不配置则降级为 MemoryStore。 */
export const SHARED_AUTH_SESSION_REDIS_URL = 'redis://root:123456@127.0.0.1:6379/0';
/** Session Cookie 签名密钥，至少 16 位。 */
export const SHARED_AUTH_SESSION_SECRET = 's1111111111111111';
