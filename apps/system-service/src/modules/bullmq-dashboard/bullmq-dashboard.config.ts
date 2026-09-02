import { ConfigKeys, getConfig } from '@nest-cloud/common';
import {
  WEEKLY_REPORT_QUEUE_NAME,
  WEEKLY_REPORT_QUEUE_PREFIX,
} from '../weekly-commit-report/weekly-report.constants';
import { BULLMQ_DEFAULT_PERMISSION } from './bullmq-dashboard.constants';

export interface BullmqDashboardConfig {
  redisUrl?: string;
  queueNames: string[];
  prefix: string;
  requireAuth: boolean;
  permissionCode: string;
}

export function readBullmqDashboardConfig(): BullmqDashboardConfig {
  const redisUrl = validateRedisUrl(
    getConfig<string>(ConfigKeys.SessionRedisUrl, '', false).trim(),
  );
  const nodeEnv = getConfig<string>(ConfigKeys.NodeEnv, 'development', false).trim().toLowerCase();

  return {
    redisUrl,
    queueNames: [WEEKLY_REPORT_QUEUE_NAME],
    prefix: WEEKLY_REPORT_QUEUE_PREFIX,
    requireAuth: nodeEnv === 'production',
    permissionCode: BULLMQ_DEFAULT_PERMISSION,
  };
}

export function validateRedisUrl(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'redis:' && url.protocol !== 'rediss:') ||
      !url.hostname ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== '/' && !/^\/\d+$/.test(url.pathname))
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
