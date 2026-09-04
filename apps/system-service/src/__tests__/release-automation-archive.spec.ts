import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModifyLogArchiveService } from '../modules/release-automation/modify-log-archive.service';
import { sha256 } from '../modules/release-automation/release-automation.security';
import type {
  ModifyLogSource,
  ReleaseUnit,
} from '../modules/release-automation/release-automation.types';

const releaseUnit: ReleaseUnit = {
  repository: 'acme/project',
  targetBranch: 'custom/prod',
  candidateSha: 'a'.repeat(40),
  version: '1.9.0',
};

describe('modify-log archive gate', () => {
  it('archives atomically and clears only an unchanged source with one token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-automation-'));
    const sourcePath = join(directory, 'modify-log.sql');
    const archiveDir = join(directory, 'archive');
    const content = 'INSERT INTO users (id) VALUES (1);\n';
    await writeFile(sourcePath, content, 'utf8');
    const source: ModifyLogSource = {
      path: sourcePath,
      checksum: sha256(content),
      generation: `${sha256(content)}:${Buffer.byteLength(content)}:fixed`,
      content,
      records: [{ sequence: 1, action: 'insert', table: 'users', values: { id: 1 } }],
    };
    const service = new ModifyLogArchiveService({ archiveDir });
    const artifact = await service.archive({ source, sql: '-- version\n' + content, releaseUnit });
    expect(await readFile(artifact.archivePath, 'utf8')).toContain('-- version');
    const token = service.issueClearConfirmation(artifact.archiveId);
    await expect(
      service.compareAndClear({
        archiveId: artifact.archiveId,
        sourcePath,
        sourceChecksum: source.checksum,
        generation: source.generation,
        jobId: 'release-test',
        version: '1.9.0',
        confirmationToken: token,
        mode: 'dry-run',
      }),
    ).rejects.toThrow('独立 apply gate');
    expect(await readFile(sourcePath, 'utf8')).toBe(content);
    await expect(
      service.compareAndClear({
        archiveId: artifact.archiveId,
        sourcePath,
        sourceChecksum: source.checksum,
        generation: source.generation,
        jobId: 'release-test',
        version: '1.9.0',
        confirmationToken: token,
        mode: 'apply',
      }),
    ).resolves.toBe('cleared');
    expect(await readFile(sourcePath, 'utf8')).toBe('');
    await expect(
      service.compareAndClear({
        archiveId: artifact.archiveId,
        sourcePath,
        sourceChecksum: source.checksum,
        generation: source.generation,
        jobId: 'release-test',
        version: '1.9.0',
        confirmationToken: token,
        mode: 'apply',
      }),
    ).resolves.toBe('already-cleared');
  });

  it('does not report cleared when clear metadata persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-automation-'));
    const sourcePath = join(directory, 'modify-log.sql');
    const archiveDir = join(directory, 'archive');
    const content = 'DELETE FROM users WHERE id=3;\n';
    await writeFile(sourcePath, content, 'utf8');
    const checksum = sha256(content);
    const source: ModifyLogSource = {
      path: sourcePath,
      checksum,
      generation: 'generation-2',
      content,
      records: [{ sequence: 1, action: 'delete', table: 'users', where: { id: 3 } }],
    };
    const service = new ModifyLogArchiveService({ archiveDir });
    const artifact = await service.archive({ source, sql: content, releaseUnit });
    const token = service.issueClearConfirmation(artifact.archiveId);
    vi.spyOn(service as any, 'writeMetadata').mockRejectedValueOnce(new Error('disk full'));

    await expect(
      service.compareAndClear({
        archiveId: artifact.archiveId,
        sourcePath,
        sourceChecksum: checksum,
        generation: 'generation-2',
        jobId: 'release-test',
        version: '1.9.0',
        confirmationToken: token,
        mode: 'apply',
      }),
    ).rejects.toThrow('disk full');
    expect(await readFile(sourcePath, 'utf8')).toBe(content);
    expect(service.getMetadata(artifact.archiveId)).toMatchObject({
      clearStatus: 'eligible-to-clear',
    });
  });

  it('keeps the source when its checksum changes before clear', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-automation-'));
    const sourcePath = join(directory, 'modify-log.sql');
    const archiveDir = join(directory, 'archive');
    const content = 'DELETE FROM users WHERE id=1;\n';
    await writeFile(sourcePath, content, 'utf8');
    const checksum = sha256(content);
    const source: ModifyLogSource = {
      path: sourcePath,
      checksum,
      generation: 'generation-1',
      content,
      records: [{ sequence: 1, action: 'delete', table: 'users', where: { id: 1 } }],
    };
    const service = new ModifyLogArchiveService({ archiveDir });
    const artifact = await service.archive({ source, sql: content, releaseUnit });
    const token = service.issueClearConfirmation(artifact.archiveId);
    await writeFile(sourcePath, content + 'INSERT INTO users (id) VALUES (2);\n', 'utf8');
    await expect(
      service.compareAndClear({
        archiveId: artifact.archiveId,
        sourcePath,
        sourceChecksum: checksum,
        generation: 'generation-1',
        jobId: 'release-test',
        version: '1.9.0',
        confirmationToken: token,
        mode: 'apply',
      }),
    ).rejects.toThrow('变化');
    expect(await readFile(sourcePath, 'utf8')).toContain('VALUES (2)');
  });
});
