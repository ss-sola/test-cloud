import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as dotenv from 'dotenv';
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { getOptions } from './options';
import { ProjectException } from '@/exception/global.exception';
import { enableConfigCenter } from './enable-config-center.decorator';
import { SYNC_CONFIG_INTERVAL } from '@/client/registry-client.constants';
import { isSameService } from '@/util/common.util';
import { ConfigKeys } from '@/config/keys';

const logger = new Logger('ConfigCenter');

type ConfigCenterState = {
  serviceName: string;
  syncTime?: string;
  mainConfig: Record<string, any>;
  devConfig: Record<string, any>;
};

const configCenter: ConfigCenterState = {
  serviceName: '',
  syncTime: undefined,
  mainConfig: {},
  devConfig: {},
};

let refreshTimer: NodeJS.Timeout | undefined;

type RemoteConfigPayload = {
  configs?: Array<Record<string, any>>;
  mergedConfig?: Record<string, any>;
};

type ConfigClass<T> = new () => T;
type ConfigValueType = 'string' | 'number' | 'boolean' | 'json';

export async function initConfigCenter() {
  configCenter.syncTime = undefined;
  configCenter.devConfig = {};
  configCenter.mainConfig = {};

  const options = getOptions();
  loadConfig();
  configCenter.serviceName = getConfig<string>(ConfigKeys.ServiceName, '', false);

  if (!enableConfigCenter(options.AppModule)) {
    return;
  }

  const serviceName = configCenter.serviceName;

  if (shouldSkipInitialRemoteSync()) {
    logger.warn('Config center initial sync skipped because target points to current service');
  } else {
    try {
      await syncRemoteConfig(serviceName);
    } catch (error) {
      logger.error(
        `Config center initial sync failed, continue with local config: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  refreshTimer = setInterval(() => {
    syncRemoteConfig(serviceName).catch((error) => {
      logger.error(
        `Config center refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    });
  }, SYNC_CONFIG_INTERVAL);
}

export function getConfig<T>(
  key: string,
  defaultValue?: T,
  required = true,
  valueType?: ConfigValueType,
): T {
  const value = getValueByPath(configCenter.mainConfig, key);
  if (value === undefined && defaultValue === undefined && required) {
    throw new ProjectException(`Config key not found: ${key}`);
  }

  const resolvedValue = value ?? defaultValue;
  return convertConfigValue(
    key,
    resolvedValue,
    valueType ?? inferConfigValueType(defaultValue),
  ) as T;
}

export function validateConfig<T>(configClass: ConfigClass<T>) {
  const configInstance = plainToInstance(configClass, configCenter.mainConfig, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(configInstance as object, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });

  if (errors.length > 0) {
    throw new ProjectException(
      `Config validation failed: ${formatValidationErrors(errors).join('; ')}`,
    );
  }

  mergeConfig(configCenter.mainConfig, configInstance as Record<string, any>);
  return configInstance;
}

/**
 * 加载本地配置文件到 devConfig，并初始化 mainConfig
 * @param filePaths 可选，配置文件路径数组。如果不传，则默认读取 src 同级的 .env 文件
 */
export function loadConfig(filePaths?: string[]) {
  if (!filePaths || filePaths.length === 0) {
    // 默认 src 同级下的 .env 文件
    const defaultEnv = path.resolve(process.cwd(), '.env');
    filePaths = [defaultEnv];
  }

  for (const filePath of filePaths) {
    const absPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(absPath)) {
      logger.warn(`Config file not found: ${absPath}`);
      continue;
    }

    let parsed: Record<string, any>;

    const raw = fs.readFileSync(absPath, 'utf-8');

    if (filePath.endsWith('.json')) {
      parsed = JSON.parse(raw);
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      parsed = yaml.load(raw) as Record<string, any>;
    } else if (filePath.endsWith('.env')) {
      parsed = dotenv.parse(raw);
    } else {
      logger.warn(`Unsupported config file type: ${absPath}`);
      continue;
    }

    mergeConfig(configCenter.devConfig, parsed);
  }

  configCenter.mainConfig = mergeConfig({}, configCenter.devConfig);
}

async function syncRemoteConfig(serviceName: string) {
  const configUrl = getConfig<string>(ConfigKeys.RegistryUrl);
  const names = getConfig<string>(ConfigKeys.ConfigNames, '', false)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(',');
  if (names.length === 0) {
    return;
  }
  const response = await axios.get(`${configUrl}/api/config-files/client/pull`, {
    params: {
      serviceName,
      names: names || undefined,
    },
  });

  const payload = unwrapResponsePayload<RemoteConfigPayload>(response.data);
  const nextMainConfig = {};
  if (payload?.mergedConfig && isPlainObject(payload.mergedConfig)) {
    mergeConfig(nextMainConfig, payload.mergedConfig);
  }
  mergeConfig(nextMainConfig, configCenter.devConfig);
  configCenter.mainConfig = nextMainConfig;
  configCenter.syncTime = new Date().toISOString();
}

function unwrapResponsePayload<T>(payload: any): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data as T;
  }

  return payload as T;
}

function inferConfigValueType(value: unknown): ConfigValueType | undefined {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return undefined;
}

function convertConfigValue(
  key: string,
  value: unknown,
  valueType: ConfigValueType | undefined,
): unknown {
  if (value === undefined || valueType === undefined) {
    return value;
  }

  if (valueType === 'number') {
    return convertNumberConfig(key, value);
  }
  if (valueType === 'boolean') {
    return convertBooleanConfig(key, value);
  }
  if (valueType === 'json') {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  return convertStringConfig(key, value);
}

function convertNumberConfig(key: string, value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new ProjectException(`Config key type invalid: ${key} must be a number`);
}

function convertBooleanConfig(key: string, value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  throw new ProjectException(`Config key type invalid: ${key} must be a boolean`);
}

function convertStringConfig(key: string, value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new ProjectException(`Config key type invalid: ${key} must be a string`);
}

function getValueByPath(obj: Record<string, any>, pathValue: string): unknown {
  return pathValue.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') {
      return undefined;
    }

    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function mergeConfig(target: Record<string, any>, source: Record<string, any>) {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeConfig(target[key], value);
      continue;
    }

    target[key] = value;
  }

  return target;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatValidationErrors(errors: ValidationError[], parentPath = ''): string[] {
  return errors.flatMap((error) => {
    const currentPath = parentPath ? `${parentPath}.${error.property}` : error.property;
    const messages = error.constraints
      ? Object.values(error.constraints).map((message) => `${currentPath}: ${message}`)
      : [];

    if (!error.children || error.children.length === 0) {
      return messages;
    }

    return [...messages, ...formatValidationErrors(error.children, currentPath)];
  });
}

function shouldSkipInitialRemoteSync(): boolean {
  const registryUrl = getConfig<string>(ConfigKeys.RegistryUrl, '', false);
  if (!registryUrl) {
    return false;
  }

  const port = getConfig<number>(ConfigKeys.Port, 0, false);
  const currentUrl = `http://127.0.0.1:${port}`;
  return isSameService(currentUrl, registryUrl);
}
