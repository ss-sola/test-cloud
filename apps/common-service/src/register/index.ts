import fg from 'fast-glob';
import 'reflect-metadata';
import { DynamicModule, Provider, Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { getMetadataArgsStorage } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigInjectorService } from '@/config-center/config-injector.service';
import NodeModule from 'module';
import { AfterAppBootstrapRunner } from '@/ext/after-application-bootstrap.runner';
function isInjectable(target: Provider): boolean {
  // @Injectable 触发了 design:paramtypes 元数据
  return Reflect.hasMetadata('__injectable__', target);
}

function isController(target: Provider): boolean {
  // Nest Controller 装饰器在类上也有一个元数据：'path' 你可以尝试检测这个元数据
  return Reflect.hasMetadata('__controller__', target);
}

/**
 * 扫描 dist 文件夹里的 js 文件，动态导入并自动分类
 */
export async function scanAutoRegister(pattern = 'dist/**/*.js') {
  // 存储自动发现的 providers 和 controllers
  const providers: Provider[] = [];
  const controllers: Type<any>[] = [];

  const files = await fg(pattern, {
    absolute: true,
    ignore: [
      '**/*.spec.ts',
      '**/*.spec.js',
      '**/*.e2e-spec.ts',
      '**/*.e2e-spec.js',
      '**/*.test.ts',
      '**/*.test.js',
    ],
  });
  for (const file of files) {
    const module = (await import(file)) as NodeModule;
    for (const exportedKey in module) {
      const exported = module[exportedKey] as Provider;
      if (typeof exported === 'function') {
        if (isController(exported)) {
          controllers.push(exported);
        } else if (isInjectable(exported)) {
          providers.push(exported);
        }
      }
    }
  }
  const imports: any[] = getMetadataArgsStorage().tables.map((item) => item.target);
  const importsModule = TypeOrmModule.forFeature(imports);
  return { providers, controllers, importsModule };
}

export async function register(module: Type<any>, pattern?: string): Promise<DynamicModule> {
  const { providers, controllers, importsModule } = await scanAutoRegister(pattern);
  return {
    module: module,
    imports: [DiscoveryModule, importsModule],
    providers: [...providers, ConfigInjectorService, AfterAppBootstrapRunner],
    controllers,
    exports: providers,
  };
}
