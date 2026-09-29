import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateReleaseAutomationJobDto } from '../modules/release-automation/dto/release-automation.dto';
import { parseJenkinsJobUrl, readReleaseAutomationConfig } from '../modules/release-automation/release-automation.config';
import { diffEnv, normalizeEnvValue, parseEnv } from '../modules/release-automation/env-diff.util';
import { renderEnvConfigSql } from '../modules/release-automation/env-sql.renderer';
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

  it('renders only added and changed env values as sorted sys_config upserts', () => {
    const sql = renderEnvConfigSql(
      'CHANGED=old\nREMOVED=gone\nSAME=stable\n',
      'CHANGED=O\'Reilly\nNEW_BOOL=true\nNEW_JSON={"enabled":true}\nNEW_NUMBER=3000\nEMPTY=\nSAME=stable\n',
    );

    expect(sql).toContain("VALUES ('CHANGED', 'O''Reilly', 'string', '')");
    expect(sql).toContain("VALUES ('NEW_BOOL', 'true', 'string', '')");
    expect(sql).toContain("VALUES ('NEW_JSON', '{\"enabled\":true}', 'json', '')");
    expect(sql).toContain("VALUES ('NEW_NUMBER', '3000', 'number', '')");
    expect(sql).toContain("VALUES ('EMPTY', '', 'string', '')");
    expect(sql).not.toContain('REMOVED');
    expect(sql).not.toContain('SAME');
    expect(sql).not.toContain('CREATE TABLE');
    expect(sql).not.toContain('created_at');
    expect(sql.indexOf('CHANGED')).toBeLessThan(sql.indexOf('EMPTY'));
    expect(() => renderEnvConfigSql('', `${'A'.repeat(129)}=value`)).toThrow('sys_config.key');
  });

  it('validates the env SQL option as a boolean and defaults it off', () => {
    const dto = (environmentToSql: unknown) =>
      Object.assign(new CreateReleaseAutomationJobDto(), {
        targetBranch: 'release',
        gitTag: 'v1',
        gitAddress: 'https://github.com/acme/project.git',
        branch: 'release',
        environmentToSql,
      });

    expect(validateSync(dto(true)).some((error) => error.property === 'environmentToSql')).toBe(
      false,
    );
    expect(validateSync(dto('true')).some((error) => error.property === 'environmentToSql')).toBe(
      true,
    );

    const pageConfig = {
      gitAddress: 'https://github.com/acme/project.git',
      branch: 'release',
      githubToken: '',
      jenkinsToken: '',
      jenkinsBaseUrl: '',
      feishuAppId: '',
      feishuAppSecret: '',
    };
    expect(readReleaseAutomationConfig(pageConfig).environmentToSql).toBe(false);
    expect(readReleaseAutomationConfig({ ...pageConfig, environmentToSql: true }).environmentToSql).toBe(
      true,
    );
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
