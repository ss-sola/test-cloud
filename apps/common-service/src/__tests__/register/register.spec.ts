import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscoveryModule } from '@nestjs/core';
import { ConfigInjectorService } from '../../config-center/config-injector.service';
import { AfterAppBootstrapRunner } from '../../ext/after-application-bootstrap.runner';

const { fastGlobMock } = vi.hoisted(() => ({
  fastGlobMock: vi.fn(),
}));

vi.mock('fast-glob', () => ({
  default: fastGlobMock,
}));

import { register, scanAutoRegister } from '../../register';

class AppModule {}

describe('register', () => {
  beforeEach(() => {
    fastGlobMock.mockReset();
    fastGlobMock.mockResolvedValue([] as never);
  });

  it('should ignore test files during scan and keep base module structure', async () => {
    const scanned = await scanAutoRegister('dist/**/*.js');
    const dynamicModule = await register(AppModule, 'dist/**/*.js');

    expect(fastGlobMock).toHaveBeenCalledWith(
      'dist/**/*.js',
      expect.objectContaining({
        absolute: true,
        ignore: [
          '**/*.spec.ts',
          '**/*.spec.js',
          '**/*.e2e-spec.ts',
          '**/*.e2e-spec.js',
          '**/*.test.ts',
          '**/*.test.js',
        ],
      }),
    );
    expect(scanned.providers).toEqual([]);
    expect(scanned.controllers).toEqual([]);
    expect(dynamicModule.module).toBe(AppModule);
    expect(dynamicModule.imports?.[0]).toBe(DiscoveryModule);
    expect(dynamicModule.providers).toEqual(
      expect.arrayContaining([ConfigInjectorService, AfterAppBootstrapRunner]),
    );
    expect(dynamicModule.controllers).toEqual([]);
    expect(dynamicModule.exports).toEqual([]);
  });
});
