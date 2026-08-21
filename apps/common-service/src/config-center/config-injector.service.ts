// config-injector.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { getConfigKeyMetadata } from './config-key.decorator';
import { getConfig } from '.';

@Injectable()
export class ConfigInjectorService implements OnModuleInit {
  private readonly logger = new Logger(ConfigInjectorService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    const providers = this.discovery.getProviders();

    for (const wrapper of providers) {
      const instance = wrapper?.instance as object;
      if (!instance || typeof instance !== 'object') continue;

      const metadata = getConfigKeyMetadata(instance);
      if (metadata.length === 0) continue;

      for (const { propertyKey, configKey, defaultValue } of metadata) {
        Object.defineProperty(instance, propertyKey, {
          get() {
            return getConfig(configKey, defaultValue, false);
          },

          enumerable: true,
          configurable: true,
        });
      }
    }
  }
}
