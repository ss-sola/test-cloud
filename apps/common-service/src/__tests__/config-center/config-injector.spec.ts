import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as configCenter from '../../config-center';
import { ConfigInjectorService } from '../../config-center/config-injector.service';
import { ConfigKey } from '../../config-center/config-key.decorator';

class DemoProvider {
  @ConfigKey('feature.token', 'fallback-token')
  token?: string;
}

describe('ConfigInjectorService', () => {
  it('should define getters for decorated properties and read from getConfig', () => {
    const instance = new DemoProvider();
    const discovery = {
      getProviders: vi.fn(() => [{ instance }]),
    };
    const getConfigSpy = vi.spyOn(configCenter, 'getConfig').mockReturnValue('resolved-token');

    try {
      const service = new ConfigInjectorService(discovery as never, {} as never);
      service.onModuleInit();

      expect(instance.token).toBe('resolved-token');
      expect(getConfigSpy).toHaveBeenCalledWith('feature.token', 'fallback-token', false);
    } finally {
      getConfigSpy.mockRestore();
    }
  });
});
