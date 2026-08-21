// client/registry-client.service.ts
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import { RegistryClientOption, ServiceInstance } from './registry-client.options';
import {
  HEARTBEAT_INTERVAL,
  REGISTER_MAX_RETRIES,
  REGISTER_RETRY_INTERVAL,
  REGISTRY_CLIENT_OPTIONS,
  SYNC_INTERVAL,
} from './registry-client.constants';
import { AfterApplicationBootstrap } from '@/ext/after-application-bootstrap.interface';

import { isSameService } from '@/util/common.util';
import { enableAutoRegister } from './enable-registry-client.decorator';
import { getOptions } from '@/config-center/options';

@Injectable()
export class RegistryClientService implements AfterApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RegistryClientService.name);
  private instanceId: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private isRegistering = false;
  private roundRobinCounter = new Map<string, number>(); // 为每个服务维护一个轮询计数
  private cache = new Map<string, ServiceInstance[]>(); // 本地缓存

  constructor(
    @Inject(REGISTRY_CLIENT_OPTIONS)
    private readonly options: RegistryClientOption,
  ) {
    this.instanceId = `${options.serviceName}-${options.serviceHost}-${options.servicePort}`;
  }

  async afterApplicationBootstrap() {
    // 如果注册中心地址是自己，则不注册
    const currentUrl = `http://${this.options.serviceHost}:${this.options.servicePort}`;
    if (isSameService(currentUrl, this.options.registryUrl)) return;

    if (!enableAutoRegister(getOptions().AppModule)) return;
    // 注册自己
    await this.registerWithRetry();
    await this.syncServices(); // 启动时先拉一次

    // 定时同步服务列表
    const syncInterval = this.options.syncInterval ?? SYNC_INTERVAL;
    this.syncTimer = setInterval(() => this.syncServices(), syncInterval);
  }

  async onModuleDestroy() {
    await this.unregister();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
  }

  // === 注册中心交互 ===
  private async registerWithRetry() {
    if (this.isRegistering) {
      return;
    }

    this.isRegistering = true;

    try {
      for (let attempt = 1; attempt <= REGISTER_MAX_RETRIES; attempt += 1) {
        try {
          await this.register();
          return;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;

          this.logger.error(
            `Register failed (${attempt}/${REGISTER_MAX_RETRIES}): ${message}`,
            stack,
          );

          if (attempt >= REGISTER_MAX_RETRIES) {
            this.logger.error(
              `Register aborted after ${REGISTER_MAX_RETRIES} attempts: ${this.instanceId}`,
            );
            return;
          }

          await delay(REGISTER_RETRY_INTERVAL);
        }
      }
    } finally {
      this.isRegistering = false;
    }
  }

  private async register() {
    await axios.post(`${this.options.registryUrl}/api/registry/register`, {
      id: this.instanceId,
      name: this.options.serviceName,
      host: this.options.serviceHost,
      port: this.options.servicePort,
      metadata: this.options.metadata,
    });
    this.logger.log(`Registered as ${this.instanceId}`);

    this.startHeartbeat();
  }

  private async unregister() {
    try {
      await axios.post(`${this.options.registryUrl}/api/registry/unregister/${this.instanceId}`);
      this.logger.log(`Unregistered ${this.instanceId}`);
    } catch (err: any) {
      this.logger.error(
        `Unregister failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private async heartbeat() {
    try {
      const res = await axios.post<{ success: boolean }>(
        `${this.options.registryUrl}/api/registry/heartbeat/${this.instanceId}`,
      );
      const heartbeatResult = unwrapResponsePayload<{ success: boolean }>(res.data);

      if (!heartbeatResult.success) {
        this.stopHeartbeat();
        await this.registerWithRetry(); // 如果心跳返回false，说明实例不存在，重新注册
      }
      this.logger.debug(`Heartbeat ${this.instanceId} ${heartbeatResult.success}`);
    } catch (err: any) {
      this.logger.error(
        `Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) {
      return;
    }

    const interval = this.options.heartbeatInterval ?? HEARTBEAT_INTERVAL;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), interval);
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async syncServices() {
    try {
      const res = await axios.get(`${this.options.registryUrl}/api/registry/all`);
      const serviceMap = unwrapResponsePayload<Record<string, ServiceInstance[]>>(res.data);

      const newCache = new Map<string, ServiceInstance[]>();
      for (const key in serviceMap) {
        newCache.set(key, serviceMap[key]);
      }

      this.cache = newCache; // 只有成功时才替换
      this.logger.debug(`服务实例已同步到本地缓存: ${JSON.stringify(serviceMap)}`);
    } catch (err: any) {
      this.logger.error(
        `Sync services failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  // === 本地服务发现 ===
  getInstances(serviceName: string): ServiceInstance[] {
    return this.cache.get(serviceName) ?? [];
  }

  listServices(): Array<{
    serviceName: string;
    instances: ServiceInstance[];
  }> {
    return [...this.cache.entries()].map(([serviceName, instances]) => ({
      serviceName,
      instances: [...instances],
    }));
  }

  getInstance(
    serviceName: string,
    strategy: 'random' | 'roundRobin' = 'random',
  ): ServiceInstance | null {
    const instances = this.getInstances(serviceName);
    if (!instances.length) return null;

    if (strategy === 'random') {
      return instances[Math.floor(Math.random() * instances.length)];
    }

    if (strategy === 'roundRobin') {
      const counter = this.roundRobinCounter.get(serviceName) ?? 0;
      const instance = instances[counter % instances.length];
      this.roundRobinCounter.set(serviceName, counter + 1);
      return instance;
    }

    return instances[0];
  }
}

function delay(timeout: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

function unwrapResponsePayload<T>(payload: any): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data as T;
  }

  return payload as T;
}
