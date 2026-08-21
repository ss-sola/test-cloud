// decorators/config-key.decorator.ts
import 'reflect-metadata';

const CONFIG_KEY_METADATA = 'config-key:fields';

export interface ConfigKeyMetadata<T = any> {
  propertyKey: string | symbol;
  configKey: string;
  defaultValue?: T;
}

/**
 * 装饰器：注入配置值
 * @param key 配置键名，支持嵌套路径 'a.b.c'
 * @param defaultValue 默认值，可选
 */
export function ConfigKey<T = any>(key: string, defaultValue?: T): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const existing: ConfigKeyMetadata[] =
      Reflect.getMetadata(CONFIG_KEY_METADATA, target.constructor) || [];

    Reflect.defineMetadata(
      CONFIG_KEY_METADATA,
      [...existing, { propertyKey, configKey: key, defaultValue }],
      target.constructor,
    );
  };
}

/**
 * 获取类上所有 ConfigKey 元数据
 */
export function getConfigKeyMetadata(target: object): ConfigKeyMetadata[] {
  return (Reflect.getMetadata(CONFIG_KEY_METADATA, target.constructor) ||
    []) as ConfigKeyMetadata[];
}
