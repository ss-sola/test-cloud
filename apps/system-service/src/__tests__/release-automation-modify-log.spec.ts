import { describe, expect, it } from 'vitest';
import { parseModifyLogContent } from '../modules/release-automation/modify-log-gateway.service';
import { VersionSqlRenderer } from '../modules/release-automation/version-sql.renderer';
import { RELEASE_AUTOMATION_VERSION } from '../modules/release-automation/release-automation.constants';
import type { ModifyLogRecord } from '../modules/release-automation/release-automation.types';

const sourceChecksum = 'a'.repeat(64);

describe('modify-log deterministic SQL', () => {
  it('parses controlled SQL and renders sorted escaped statements', () => {
    const records = parseModifyLogContent(
      "UPDATE users SET name='O''Brien', active=TRUE WHERE id=2;\nINSERT INTO users (id, name) VALUES (1, 'Alice');",
      20,
    );
    const renderer = new VersionSqlRenderer();
    const first = renderer.render({ version: RELEASE_AUTOMATION_VERSION, sourceChecksum, records });
    const second = renderer.render({
      version: RELEASE_AUTOMATION_VERSION,
      sourceChecksum,
      records: [...records].reverse(),
    });
    expect(first).toBe(second);
    expect(first).toContain("'O''Brien'");
    expect(first).toContain('-- record-count: 2');
    expect(first.indexOf('UPDATE')).toBeLessThan(first.indexOf('INSERT INTO'));
  });

  it('rejects raw or unsafe actions', () => {
    expect(() => parseModifyLogContent('DROP TABLE users;', 10)).toThrow('未允许');
    const unsafe: ModifyLogRecord[] = [
      {
        sequence: 1,
        action: 'insert',
        table: 'users',
        values: { name: "x'); DROP TABLE users;--" },
      },
    ];
    const sql = new VersionSqlRenderer().render({ sourceChecksum, records: unsafe });
    expect(sql).toContain("x''); DROP TABLE users;--");
  });

  it('accepts opaque release metadata without applying Git naming rules', () => {
    const sql = new VersionSqlRenderer().render({
      version: 'release tag/非标准',
      sourceChecksum: 'checksum that is not a SHA',
      records: [],
      releaseUnit: {
        repository: 'owner/repository with spaces',
        targetBranch: 'main/release candidate',
        gitTag: 'release tag/非标准',
        candidateSha: 'candidate SHA',
        version: 'release tag/非标准',
      },
    });

    expect(sql).toContain('-- release-version: release tag/非标准');
    expect(sql).toContain('owner/repository with spaces');
  });

  it('keeps SQL comment metadata free of control characters', () => {
    expect(() =>
      new VersionSqlRenderer().render({
        version: 'release\ntag',
        sourceChecksum: 'checksum',
        records: [],
      }),
    ).toThrow('控制字符');
  });
});
