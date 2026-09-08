import { describe, expect, it } from 'vitest';
import { parseJenkinsJobUrl } from '../modules/release-automation/release-automation.config';
import { diffEnv, normalizeEnvValue, parseEnv } from '../modules/release-automation/env-diff.util';
import { RELEASE_AUTOMATION_REDACTED_VALUE } from '../modules/release-automation/release-automation.constants';
import {
  payloadHash,
  redactSensitiveText,
  stableStringify,
} from '../modules/release-automation/release-automation.security';

describe('release automation pure security and ENV rules', () => {
  it('classifies ENV changes deterministically and masks sensitive values', () => {
    const result = diffEnv(
      'A=one\nSECRET_TOKEN="old-value"\nREMOVED=yes\nSAME="x"\n',
      'A=two\nSECRET_TOKEN=new-value\nADDED=yes\nSAME=x\n',
    );
    expect(result.added.map((item) => item.key)).toEqual(['ADDED']);
    expect(result.removed.map((item) => item.key)).toEqual(['REMOVED']);
    expect(result.changed.map((item) => item.key)).toEqual(['A', 'SECRET_TOKEN']);
    expect(result.unchanged[0]).toMatchObject({ key: 'SAME', status: 'unchanged' });
    expect(result.changed.find((item) => item.key === 'SECRET_TOKEN')).toMatchObject({
      beforeValue: RELEASE_AUTOMATION_REDACTED_VALUE,
      afterValue: RELEASE_AUTOMATION_REDACTED_VALUE,
      sensitive: true,
    });
  });

  it('normalizes quoted values without retaining them in sensitive output', () => {
    expect(normalizeEnvValue('" value "')).toBe('value');
    expect(parseEnv('export NAME=alice\n# comment\n').get('NAME')).toEqual({
      normalized: 'alice',
      sensitive: false,
    });
    expect(redactSensitiveText('token=secret-value')).not.toContain('secret-value');
  });

  it('redacts credentials and query data from URL error details', () => {
    const redacted = redactSensitiveText(
      'request https://user:password@example.test/path?token=secret-value',
    );
    expect(redacted).toContain('https://example.test');
    expect(redacted).not.toContain('user:password');
    expect(redacted).not.toContain('secret-value');
  });

  it('uses sorted JSON for stable idempotency hashes', () => {
    expect(stableStringify({ z: 1, a: { y: true, x: 2 } })).toBe('{"a":{"x":2,"y":true},"z":1}');
    expect(payloadHash({ b: 2, a: 1 })).toBe(payloadHash({ a: 1, b: 2 }));
  });

  it('parses a dynamic Jenkins job URL into API paths', () => {
    expect(
      parseJenkinsJobUrl(
        'http://192.168.88.223:8080/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/',
      ),
    ).toEqual({
      baseUrl: 'http://192.168.88.223:8080',
      jobPath: '/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2',
    });
    expect(
      parseJenkinsJobUrl(
        'http://192.168.88.223:8080/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/buildWithParameters',
      ),
    ).toEqual({
      baseUrl: 'http://192.168.88.223:8080',
      jobPath: '/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2',
    });
    expect(() => parseJenkinsJobUrl('http://jenkins.test/job/demo?token=secret')).toThrow(
      'Jenkins',
    );
  });
});
