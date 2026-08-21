// client/registry-client.module.ts
import { DynamicModule, FactoryProvider, Module } from '@nestjs/common';
import { RegistryClientService } from './registry-client.service';
import { RegistryClient } from './registry-client.options';
import {
  HEARTBEAT_INTERVAL,
  REGISTRY_CLIENT_OPTIONS,
  SYNC_INTERVAL,
} from './registry-client.constants';

import { getConfig } from '@/config-center';
import { ConfigKeys } from '@/config/keys';
import { getLocalIp } from '@/util/common.util';

type RegistryClientFactory = (
  ...args: unknown[]
) => Promise<Partial<RegistryClient>> | Partial<RegistryClient>;

export interface RegistryClientAsyncOptions {
  useFactory: RegistryClientFactory;
  inject?: FactoryProvider['inject'];
}

@Module({})
export class RegistryClientModule {
  /**
   * 异步注册
   */
  static registerAsync(asyncOptions: RegistryClientAsyncOptions): DynamicModule {
    const asyncProvider: FactoryProvider<RegistryClient> = {
      provide: REGISTRY_CLIENT_OPTIONS,
      inject: asyncOptions.inject,
      useFactory: async (...args: Parameters<RegistryClientFactory>) => {
        const options = await asyncOptions.useFactory(...args);

        const serviceHost = getConfig<string>(ConfigKeys.ServiceHost, getLocalIp());
        const servicePort = getConfig<number>(ConfigKeys.Port, 0, false);
        const serviceName =
          options.serviceName || getConfig<string>(ConfigKeys.ServiceName, '', false);
        const heartbeatInterval = options.heartbeatInterval ?? HEARTBEAT_INTERVAL;
        const syncInterval = options.syncInterval ?? SYNC_INTERVAL;

        return {
          ...options,
          serviceHost,
          servicePort,
          serviceName,
          heartbeatInterval,
          syncInterval,
        } as RegistryClient;
      },
    };

    return {
      module: RegistryClientModule,
      providers: [asyncProvider, RegistryClientService],
      exports: [RegistryClientService],
    };
  }
}
