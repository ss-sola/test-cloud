// after-application-bootstrap.runner.ts
import { Injectable } from '@nestjs/common';
import { AfterApplicationBootstrap } from './after-application-bootstrap.interface';
import { ModulesContainer } from '@nestjs/core';

@Injectable()
export class AfterAppBootstrapRunner {
  constructor(private readonly modulesContainer: ModulesContainer) {}

  async run() {
    const modules = [...this.modulesContainer.values()];

    // 保存所有实现 afterApplicationBootstrap 的实例
    const instances: AfterApplicationBootstrap[] = [];

    for (const module of modules) {
      // 遍历模块里的 providers
      for (const providerWrapper of module.providers.values()) {
        const instance = providerWrapper.instance;
        if (this.isAfterApplicationBootstrap(instance)) {
          instances.push(instance);
        }
      }

      // 遍历模块里的 controllers
      for (const controllerWrapper of module.controllers.values()) {
        const instance = controllerWrapper.instance;
        if (this.isAfterApplicationBootstrap(instance)) {
          instances.push(instance);
        }
      }
    }

    // 遍历所有实例，按需执行
    await Promise.all(instances.map((instance) => instance.afterApplicationBootstrap()));
  }
  private isAfterApplicationBootstrap(instance: any): instance is AfterApplicationBootstrap {
    return instance && typeof instance.afterApplicationBootstrap === 'function';
  }
}
