import { ModuleMetadata, Type } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';
import { getConfig } from '@/config-center';
import { ConfigKeys } from '@/config/keys';

const MARK_KEY = Symbol('EnableTypeOrm');
type ModuleClass = Type<unknown>;
type ModuleImports = NonNullable<ModuleMetadata['imports']>;
type DatabaseDriver = DataSourceOptions['type'];

function getModuleImports(target: object): ModuleImports {
  return (Reflect.getMetadata('imports', target) as ModuleImports | undefined) ?? [];
}

export function EnableTypeOrm() {
  return (target: ModuleClass) => {
    Reflect.defineMetadata(MARK_KEY, true, target);

    const existingImports = getModuleImports(target);
    const typeOrmModule = TypeOrmModule.forRootAsync({
      useFactory: () => {
        return {
          type: getConfig<DatabaseDriver>(ConfigKeys.DbDriver),
          host: getConfig<string>(ConfigKeys.DbHost),
          port: getConfig<number>(ConfigKeys.DbPort),
          username: getConfig<string>(ConfigKeys.DbUsername),
          password: getConfig<string>(ConfigKeys.DbPassword),
          database: getConfig<string>(ConfigKeys.DbDatabase),
          entities: [`${process.cwd()}/dist/**/*.entity.js`],
          synchronize: getConfig<boolean>(ConfigKeys.DbSynchronize, false),
        } as TypeOrmModuleOptions;
      },
    });
    Reflect.defineMetadata('imports', [...existingImports, typeOrmModule], target);
  };
}

export function enableTypeOrm(target: object) {
  return Reflect.hasMetadata(MARK_KEY, target);
}
