import { describe, expect, it, vi } from 'vitest';
import { GitHubReleaseClientService } from '../modules/release-automation/github-release-client.service';
import { ReleaseAutomationService } from '../modules/release-automation/release-automation.service';
import type { ReleaseAutomationConfig } from '../modules/release-automation/release-automation.config';

const sha = 'a'.repeat(40);

function config(): ReleaseAutomationConfig {
  return {
    version: '1.9.0',
    githubBaseUrl: 'https://api.github.test',
    githubAllowedHosts: ['api.github.test'],
    githubToken: 'runtime-token',
    githubTimeoutMs: 100,
    githubMaxRetries: 0,
    githubMaxResponseBytes: 100_000,
    modifyLogPath: 'modify-log.sql',
    modifyLogArchiveDir: 'var/archive',
    modifyLogMaxBytes: 100_000,
    modifyLogMaxLines: 100,
    jenkinsTimeoutMs: 100,
    jenkinsMaxRetries: 0,
    jenkinsPollIntervalMs: 1,
    jenkinsQueueTimeoutMs: 100,
    jenkinsBuildTimeoutMs: 100,
    redisKeyPrefix: 'release-automation',
  };
}

function response(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(body),
  };
}

function refResponse(ref: string) {
  return JSON.stringify({ ref, object: { sha, type: 'commit' } });
}

describe('release automation Git service', () => {
  it('reconciles a concurrent tag creation without retrying POST', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(404, JSON.stringify({ message: 'Not Found' })))
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/dev/master')))
      .mockResolvedValueOnce(response(422, JSON.stringify({ message: 'Reference exists' })))
      .mockResolvedValueOnce(response(200, refResponse('refs/tags/1.9.0')));
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.ensureTag({
        repository: 'acme/project',
        tag: '1.9.0',
        sourceBranch: 'dev/master',
        mode: 'apply',
        sideEffectGate: 'release-gate-' + 'x'.repeat(20),
        config: config(),
      }),
    ).resolves.toEqual({ status: 'reconciled', sha });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'GET',
      'GET',
      'POST',
      'GET',
    ]);
  });

  it('treats an existing tag as idempotent without comparing source SHA', async () => {
    const existingSha = 'b'.repeat(40);
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      response(
        200,
        JSON.stringify({
          ref: 'refs/tags/v1.9.0-2026-09-04',
          object: { sha: existingSha, type: 'commit' },
        }),
      ),
    );
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.ensureTag({
        repository: 'acme/project',
        tag: 'v1.9.0-2026-09-04',
        sourceBranch: 'dev/master',
        mode: 'apply',
        sideEffectGate: 'release-gate-' + 'x'.repeat(20),
        config: config(),
      }),
    ).resolves.toEqual({ status: 'skipped', sha: existingSha });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts a non-custom target branch for a dry-run merge', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/main')))
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/main')))
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/dev/master')));
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.getBranchRef({ repository: 'acme/project', branch: 'main', config: config() }),
    ).resolves.toMatchObject({ ref: 'refs/heads/main', sha });
    await expect(
      service.mergeBranch({
        repository: 'acme/project',
        targetBranch: 'main',
        sourceBranch: 'dev/master',
        mode: 'dry-run',
        config: config(),
      }),
    ).resolves.toMatchObject({
      status: 'planned',
      targetBranch: 'main',
      sourceBranch: 'dev/master',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('reads and archives the exact GitHub modify-log content at the candidate ref', async () => {
    const content = 'CREATE TABLE release_marker (id INT NOT NULL);\n';
    const gateway = {
      readSource: vi.fn().mockResolvedValue({
        path: '.version/modify-log.sql',
        repository: 'acme/project',
        ref: sha,
        blobSha: 'blob-sha',
        checksum: 'content-checksum',
        generation: `${sha}:blob-sha`,
        content,
        records: [],
      }),
    };
    const archive = {
      archive: vi.fn().mockResolvedValue({
        archiveId: 'archive-id',
        artifactId: 'modify-log-artifact',
        releaseUnit: {
          repository: 'acme/project',
          targetBranch: 'main',
          candidateSha: sha,
          version: '1.9.0',
        },
        sourcePath: '.version/modify-log.sql',
        sourceRepository: 'acme/project',
        sourceRef: sha,
        sourceBlobSha: 'blob-sha',
        sourceChecksum: 'content-checksum',
        artifactChecksum: 'artifact-checksum',
        recordCount: 0,
        archivePath: 'var/archive/1.9.0.sql',
        clearStatus: 'eligible-to-clear',
      }),
    };
    const service = new ReleaseAutomationService(
      {} as never,
      {} as never,
      gateway as never,
      archive as never,
    );
    const runtimeConfig = config();
    const releaseUnit = {
      repository: 'acme/project',
      targetBranch: 'main',
      candidateSha: sha,
      version: '1.9.0',
    };

    await expect(
      service.prepareModifyLog({
        releaseUnit,
        mode: 'apply',
        config: runtimeConfig,
        jobId: 'release-job',
      }),
    ).resolves.toMatchObject({ sql: content, sourceChecksum: 'content-checksum' });
    expect(gateway.readSource).toHaveBeenCalledWith({
      repository: 'acme/project',
      ref: sha,
      config: runtimeConfig,
    });
    expect(archive.archive).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ content }), sql: content }),
    );
  });

  it('falls back to the release source branch when no candidate SHA exists', async () => {
    const gateway = {
      readSource: vi.fn().mockResolvedValue({
        path: '.version/modify-log.sql',
        repository: 'acme/project',
        ref: 'dev/master',
        blobSha: 'blob-sha',
        checksum: 'content-checksum',
        generation: 'dev/master:blob-sha',
        content: 'ALTER TABLE release_marker ADD COLUMN ready TINYINT;\n',
        records: [],
      }),
    };
    const archive = { archive: vi.fn() };
    const service = new ReleaseAutomationService(
      {} as never,
      {} as never,
      gateway as never,
      archive as never,
    );

    await service.prepareModifyLog({
      releaseUnit: { repository: 'acme/project', targetBranch: 'main', version: '1.9.0' },
      mode: 'dry-run',
      config: config(),
    });
    expect(gateway.readSource).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'acme/project', ref: 'dev/master' }),
    );
    expect(archive.archive).not.toHaveBeenCalled();
  });
});
