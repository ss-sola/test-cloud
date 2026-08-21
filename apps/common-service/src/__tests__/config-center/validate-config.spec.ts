import { describe, it, expect, vi, beforeEach } from 'vitest';
const valExistsSyncMock: ReturnType<typeof vi.fn> = vi.fn();
const valReadFileSyncMock: ReturnType<typeof vi.fn> = vi.fn();
const valYamlLoadMock: ReturnType<typeof vi.fn> = vi.fn();
const valDotenvParseMock: ReturnType<typeof vi.fn> = vi.fn();

vi.mock('fs', () => ({
  existsSync: valExistsSyncMock,
  readFileSync: valReadFileSyncMock,
}));

vi.mock('js-yaml', () => ({
  load: valYamlLoadMock,
}));

vi.mock('dotenv', () => ({
  parse: valDotenvParseMock,
}));

async function importModules() {
  vi.resetModules();
  const configCenter = await import('../../config-center');
  const configModule = await import('../../config/common.config');
  return { configCenter, configModule };
}

describe('config-center validateConfig', () => {
  beforeEach(() => {
    valExistsSyncMock.mockReset();
    valReadFileSyncMock.mockReset();
    valYamlLoadMock.mockReset();
    valDotenvParseMock.mockReset();
  });

  it('should return a typed config instance when validation passes', async () => {
    const { configCenter, configModule } = await importModules();

    valExistsSyncMock.mockReturnValue(true);
    valReadFileSyncMock.mockReturnValue(
      JSON.stringify({ ServiceName: 'common-service', Port: 3301 }),
    );

    configCenter.loadConfig(['valid.json']);
    const validated = configCenter.validateConfig(configModule.CommonConfig);

    expect(validated).toBeInstanceOf(configModule.CommonConfig);
    expect(validated.ServiceName).toBe('common-service');
    expect(validated.Port).toBe(3301);
    expect(configCenter.getConfig<number>('Port')).toBe(3301);
  });

  it('should throw a formatted error when validation fails', async () => {
    const { configCenter, configModule } = await importModules();

    valExistsSyncMock.mockReturnValue(true);
    valReadFileSyncMock.mockReturnValue(JSON.stringify({ ServiceName: '', Port: 70000 }));

    configCenter.loadConfig(['invalid.json']);

    expect(() => configCenter.validateConfig(configModule.CommonConfig)).toThrow(
      'Config validation failed:',
    );
    expect(() => configCenter.validateConfig(configModule.CommonConfig)).toThrow('ServiceName');
    expect(() => configCenter.validateConfig(configModule.CommonConfig)).toThrow('Port');
  });
});
