import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import type { NextFunction, Request, Response } from 'express';
import { BULLMQ_DASHBOARD_PATH } from './bullmq-dashboard.constants';
import { readBullmqDashboardConfig } from './bullmq-dashboard.config';

type DashboardRequest = Request & {
  session?: {
    account?: {
      permissionCodes?: string[];
    };
  };
};

@Injectable()
export class BullmqDashboardService implements OnModuleDestroy {
  private readonly logger = new Logger(BullmqDashboardService.name);
  private readonly queues: Queue[] = [];
  private mounted = false;

  async mount(app: { use: (...args: any[]) => unknown }): Promise<void> {
    if (this.mounted) return;

    const config = readBullmqDashboardConfig();
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath(BULLMQ_DASHBOARD_PATH);

    const queueAdapters = config.redisUrl
      ? config.queueNames.map((name) => {
          const queue = new Queue(name, {
            connection: { url: config.redisUrl },
            prefix: config.prefix,
            skipMetasUpdate: true,
          });
          this.queues.push(queue);
          return new BullMQAdapter(queue, {
            readOnlyMode: true,
            allowRetries: false,
          });
        })
      : [];

    if (config.queueNames.length > 0 && !config.redisUrl) {
      this.logger.warn('BullMQ 面板未配置有效 Redis 地址，当前不加载队列。');
    }

    createBullBoard({
      queues: queueAdapters,
      serverAdapter,
      options: {
        uiConfig: {
          boardTitle: 'BullMQ 面板',
          hideRedisDetails: true,
        },
      },
    });

    app.use(
      BULLMQ_DASHBOARD_PATH,
      this.createAccessMiddleware(config.requireAuth, config.permissionCode),
      serverAdapter.getRouter(),
    );
    this.mounted = true;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      this.queues.map(async (queue) => {
        try {
          await queue.close();
        } catch (error) {
          this.logger.warn(
            `BullMQ 队列连接关闭失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    this.queues.length = 0;
  }

  private createAccessMiddleware(requireAuth: boolean, permissionCode: string) {
    return (request: Request, response: Response, next: NextFunction): void => {
      if (request.method !== 'GET') {
        response.status(405).type('text').send('BullMQ 面板仅允许 GET 请求。');
        return;
      }
      if (request.path === '/api/redis/stats') {
        response.status(404).type('text').send('Not Found');
        return;
      }
      if (requireAuth) {
        const account = (request as DashboardRequest).session?.account;
        if (!account) {
          response.status(401).type('text').send('请先登录后访问 BullMQ 面板。');
          return;
        }
        const permissionCodes = account.permissionCodes ?? [];
        if (permissionCode && !permissionCodes.includes(permissionCode)) {
          response.status(403).type('text').send('没有 BullMQ 面板访问权限。');
          return;
        }
      }
      next();
    };
  }
}
