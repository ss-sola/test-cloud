import { describe, expect, it } from 'vitest';
import {
  readBullmqDashboardConfig,
  validateRedisUrl,
} from '../modules/bullmq-dashboard/bullmq-dashboard.config';
import {
  WEEKLY_REPORT_QUEUE_NAME,
  WEEKLY_REPORT_QUEUE_PREFIX,
} from '../modules/weekly-commit-report/weekly-report.constants';

describe('BullMQ dashboard configuration', () => {
  it('uses the fixed weekly-report queue and bull prefix', () => {
    const config = readBullmqDashboardConfig();

    expect(config.queueNames).toEqual([WEEKLY_REPORT_QUEUE_NAME]);
    expect(config.prefix).toBe(WEEKLY_REPORT_QUEUE_PREFIX);
  });

  it('accepts Redis URLs with an optional numeric database path', () => {
    expect(validateRedisUrl('redis://127.0.0.1:6379/0')).toBe('redis://127.0.0.1:6379/0');
    expect(validateRedisUrl('rediss://user:password@example.com:6380')).toBe(
      'rediss://user:password@example.com:6380',
    );
    expect(validateRedisUrl('http://127.0.0.1:6379')).toBeUndefined();
    expect(validateRedisUrl('redis://127.0.0.1/0?foo=bar')).toBeUndefined();
  });
});
