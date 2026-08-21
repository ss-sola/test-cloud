// src/global-store.ts
import { Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

let _moduleRef: ModuleRef | null = null;

export const GlobalStore = {
  /**
   * 在 AppModule 中注册 ModuleRef
   */
  setModuleRef(ref: ModuleRef) {
    _moduleRef = ref;
  },

  /**
   * 在任意地方获取 service 实例（单例）
   */
  get<T>(type: Type<T>): T {
    if (!_moduleRef) {
      throw new Error(
        `ModuleRef is not initialized. Did you forget to call GlobalStore.setModuleRef(...) in AppModule?`,
      );
    }
    return _moduleRef.get(type, { strict: false });
  },
};
