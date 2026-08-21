import { describe, it, expect } from 'vitest';
import { RedisSessionStore } from '../../session/redis-session';

describe('RedisSessionStore', () => {
  describe('updateAccountPermissions', () => {
    it('should expose method for updating account permissions', () => {
      const store = new RedisSessionStore({
        redisUrl: 'redis://localhost:6379',
        keyPrefix: 'session',
        ttlMs: 86400000,
      });

      expect(typeof store.updateAccountPermissions).toBe('function');
    });
  });

  describe('updateMultipleAccountsPermissions', () => {
    it('should expose method for batch updating permissions', () => {
      const store = new RedisSessionStore({
        redisUrl: 'redis://localhost:6379',
        keyPrefix: 'session',
        ttlMs: 86400000,
      });

      expect(typeof store.updateMultipleAccountsPermissions).toBe('function');
    });
  });

  describe('getRedisClient', () => {
    it('should expose Redis client', () => {
      const store = new RedisSessionStore({
        redisUrl: 'redis://localhost:6379',
        keyPrefix: 'session',
        ttlMs: 86400000,
      });

      const client = store.getRedisClient();
      expect(client).toBeDefined();
      expect(typeof client.scan).toBe('function');
    });
  });

  describe('getKeyPrefix', () => {
    it('should return the configured key prefix', () => {
      const store = new RedisSessionStore({
        redisUrl: 'redis://localhost:6379',
        keyPrefix: 'test-session',
        ttlMs: 86400000,
      });

      expect(store.getKeyPrefix()).toBe('test-session');
    });
  });
});
