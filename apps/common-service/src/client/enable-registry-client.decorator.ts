import { ModuleMetadata, Type } from '@nestjs/common';
import { getConfig } from '@/config-center';
import { ConfigKeys } from '@/config/keys';
import { RegistryClientModule } from './registry-client.module';

const MARK_KEY = Symbol('EnableAutoRegister');
type ModuleClass = Type<unknown>;
type ModuleImports = NonNullable<ModuleMetadata['imports']>;

function getModuleImports(target: object): ModuleImports {
  return (Reflect.getMetadata('imports', target) as ModuleImports | undefined) ?? [];
}

export function EnableAutoRegister() {
  return (target: ModuleClass) => {
    Reflect.defineMetadata(MARK_KEY, true, target);

    // 自动将 RegistryClientModule 注入到宿主模块的 imports 中
    const existingImports = getModuleImports(target);
    const registryModule = RegistryClientModule.registerAsync({
      useFactory: () => ({
        registryUrl: getConfig<string>(ConfigKeys.RegistryUrl),
        serviceName: getConfig<string>(ConfigKeys.ServiceName),
        metadata: getConfig<Record<string, unknown>>(ConfigKeys.ServiceMetadata, {}, false),
        heartbeatInterval: getConfig<number>(ConfigKeys.HeartbeatInterval, undefined, false),
        syncInterval: getConfig<number>(ConfigKeys.SyncInterval, undefined, false),
      }),
    });
    Reflect.defineMetadata('imports', [...existingImports, registryModule], target);
  };
}

export function enableAutoRegister(target: object) {
  return Reflect.hasMetadata(MARK_KEY, target);
}
