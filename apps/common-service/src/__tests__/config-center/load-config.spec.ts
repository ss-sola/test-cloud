import { describe, it, expect, vi, beforeEach } from 'vitest';
const loadExistsSyncMock: ReturnType<typeof vi.fn> = vi.fn();
const loadReadFileSyncMock: ReturnType<typeof vi.fn> = vi.fn();
const loadYamlLoadMock: ReturnType<typeof vi.fn> = vi.fn();
const loadDotenvParseMock: ReturnType<typeof vi.fn> = vi.fn();

vi.mock('fs', () => ({
  existsSync: loadExistsSyncMock,
  readFileSync: loadReadFileSyncMock,
}));

vi.mock('js-yaml', () => ({
  load: loadYamlLoadMock,
}));

vi.mock('dotenv', () => ({
  parse: loadDotenvParseMock,
}));

async function importConfigCenter() {
  vi.resetModules();
  return import('../../config-center');
}

describe('config-center loadConfig', () => {
  beforeEach(() => {
    loadExistsSyncMock.mockReset();
    loadReadFileSyncMock.mockReset();
    loadYamlLoadMock.mockReset();
    loadDotenvParseMock.mockReset();
  });

  it('should merge multiple local config files in order', async () => {
    const configCenter = await importConfigCenter();

    loadExistsSyncMock.mockReturnValue(true);
    loadReadFileSyncMock.mockImplementation(((filePath: string) => {
      if (filePath.endsWith('base.json')) {
        return JSON.stringify({
          ServiceName: 'common-service',
          feature: { enabled: false, threshold: 1 },
        });
      }
      if (filePath.endsWith('override.yaml')) {
        return 'feature:\n  enabled: true\nPort: 3301';
      }
      if (filePath.endsWith('local.env')) {
        return 'GlobalPrefix=/api';
      }
      return '';
    }) as never);
    loadYamlLoadMock.mockReturnValue({ feature: { enabled: true }, Port: 3301 });
    loadDotenvParseMock.mockReturnValue({ GlobalPrefix: '/api' });

    configCenter.loadConfig(['base.json', 'override.yaml', 'local.env']);

    expect(configCenter.getConfig('ServiceName')).toBe('common-service');
    expect(configCenter.getConfig('feature.enabled')).toBe(true);
    expect(configCenter.getConfig('feature.threshold')).toBe(1);
    expect(configCenter.getConfig('Port')).toBe(3301);
    expect(configCenter.getConfig('GlobalPrefix', '', false)).toBe('/api');
  });

  it('should convert config values by default value or explicit type', async () => {
    const configCenter = await importConfigCenter();

    loadExistsSyncMock.mockReturnValue(true);
    loadReadFileSyncMock.mockReturnValue(
      JSON.stringify({
        Port: '3301',
        Enabled: 'false',
        Payload: '{"ready":true}',
      }),
    );

    configCenter.loadConfig(['base.json']);

    expect(configCenter.getConfig<number>('Port', 0, false)).toBe(3301);
    expect(configCenter.getConfig<boolean>('Enabled', true, false)).toBe(false);
    expect(
      configCenter.getConfig<Record<string, boolean>>('Payload', undefined, true, 'json'),
    ).toEqual({ ready: true });
  });

  it('should throw when explicit conversion fails', async () => {
    const configCenter = await importConfigCenter();

    loadExistsSyncMock.mockReturnValue(true);
    loadReadFileSyncMock.mockReturnValue(JSON.stringify({ Port: 'invalid' }));

    configCenter.loadConfig(['base.json']);

    expect(() => configCenter.getConfig<number>('Port', 0, false)).toThrow(
      'Config key type invalid: Port must be a number',
    );
  });

  it('should support default values and throw when a required key is missing', async () => {
    const configCenter = await importConfigCenter();

    loadExistsSyncMock.mockReturnValue(true);
    loadReadFileSyncMock.mockReturnValue(JSON.stringify({ ServiceName: 'common-service' }));

    configCenter.loadConfig(['base.json']);

    expect(configCenter.getConfig('missing.value', 'fallback', false)).toBe('fallback');
    expect(() => configCenter.getConfig('Port')).toThrow('Config key not found: Port');
  });

  it('falls back to process environment values when file config is absent', async () => {
    const configCenter = await importConfigCenter();
    const previous = process.env.FEISHU_CLI_APP_ID;
    process.env.FEISHU_CLI_APP_ID = 'env-app-id';

    try {
      loadExistsSyncMock.mockReturnValue(false);
      configCenter.loadConfig(['missing.env']);
      expect(configCenter.getConfig('FEISHU_CLI_APP_ID', '', false)).toBe('env-app-id');
    } finally {
      if (previous === undefined) delete process.env.FEISHU_CLI_APP_ID;
      else process.env.FEISHU_CLI_APP_ID = previous;
    }
  });

  it('prefers file config over process environment values', async () => {
    const configCenter = await importConfigCenter();
    const previous = process.env.FEISHU_CLI_APP_ID;
    process.env.FEISHU_CLI_APP_ID = 'env-app-id';

    try {
      loadExistsSyncMock.mockReturnValue(true);
      loadReadFileSyncMock.mockReturnValue(JSON.stringify({ FEISHU_CLI_APP_ID: 'file-app-id' }));
      configCenter.loadConfig(['base.json']);
      expect(configCenter.getConfig('FEISHU_CLI_APP_ID', '', false)).toBe('file-app-id');
    } finally {
      if (previous === undefined) delete process.env.FEISHU_CLI_APP_ID;
      else process.env.FEISHU_CLI_APP_ID = previous;
    }
  });
});
