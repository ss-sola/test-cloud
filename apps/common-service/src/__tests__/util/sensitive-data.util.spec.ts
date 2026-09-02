import { describe, expect, it } from 'vitest';
import { redactSensitive } from '../../util/common.util';

describe('redactSensitive', () => {
  it('redacts sensitive keys without mutating the original value', () => {
    const value = {
      appSecret: 'secret-value',
      nested: { tenant_access_token: 'token-value', tokenCount: 3 },
      list: [{ apiKey: 'key-value', label: 'safe' }],
    };

    expect(redactSensitive(value)).toEqual({
      appSecret: '[REDACTED]',
      nested: { tenant_access_token: '[REDACTED]', tokenCount: 3 },
      list: [{ apiKey: '[REDACTED]', label: 'safe' }],
    });
    expect(value.nested.tenant_access_token).toBe('token-value');
  });

  it('marks circular references without throwing', () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(redactSensitive(value)).toEqual({ self: '[Circular]' });
  });
});
