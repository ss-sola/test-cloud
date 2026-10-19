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
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/feature/release')))
      .mockResolvedValueOnce(response(422, JSON.stringify({ message: 'Reference exists' })))
      .mockResolvedValueOnce(response(200, refResponse('refs/tags/1.9.0')));
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.ensureTag({
        repository: 'acme/project',
        tag: '1.9.0',
        sourceBranch: 'feature/release',
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

  it('reuses an existing immutable tag only when it belongs to the current branch', async () => {
    const existingSha = 'b'.repeat(40);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify({
            ref: 'refs/tags/v1.9.0-2026-09-04',
            object: { sha: existingSha, type: 'commit' },
          }),
        ),
      )
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/feature/release')))
      .mockResolvedValueOnce(
        response(200, JSON.stringify({ status: 'ahead', ahead_by: 1, behind_by: 0 })),
      );
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.ensureTag({
        repository: 'acme/project',
        tag: 'v1.9.0-2026-09-04',
        sourceBranch: 'feature/release',
        mode: 'apply',
        sideEffectGate: 'release-gate-' + 'x'.repeat(20),
        config: config(),
      }),
    ).resolves.toEqual({ status: 'skipped', sha: existingSha });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('reuses an existing tag when the merged source branch has been deleted', async () => {
    const existingSha = 'b'.repeat(40);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify({
            ref: 'refs/tags/v1.9.0',
            object: { sha: existingSha, type: 'commit' },
          }),
        ),
      )
      .mockResolvedValueOnce(response(404, JSON.stringify({ message: 'Not Found' })));
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.ensureTag({
        repository: 'acme/project',
        tag: 'v1.9.0',
        sourceBranch: 'feature/release',
        mode: 'apply',
        sideEffectGate: 'release-gate-' + 'x'.repeat(20),
        config: config(),
      }),
    ).resolves.toEqual({ status: 'skipped', sha: existingSha });
  });

  it('rejects an existing tag that is not in the current branch history', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify({
            ref: 'refs/tags/v1.9.0',
            object: { sha: 'b'.repeat(40), type: 'commit' },
          }),
        ),
      )
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/feature/release')))
      .mockResolvedValueOnce(
        response(200, JSON.stringify({ status: 'diverged', ahead_by: 2, behind_by: 1 })),
      );
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.ensureTag({
        repository: 'acme/project',
        tag: 'v1.9.0',
        sourceBranch: 'feature/release',
        mode: 'apply',
        sideEffectGate: 'release-gate-' + 'x'.repeat(20),
        config: config(),
      }),
    ).rejects.toThrow('不属于当前分支');
  });

  it('accepts a non-custom target branch for a dry-run PR', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/main')))
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/main')))
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/feature/release')));
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.getBranchRef({ repository: 'acme/project', branch: 'main', config: config() }),
    ).resolves.toMatchObject({ ref: 'refs/heads/main', sha });
    await expect(
      service.createOrReusePullRequest({
        repository: 'acme/project',
        targetBranch: 'main',
        sourceBranch: 'feature/release',
        mode: 'dry-run',
        config: config(),
      }),
    ).resolves.toMatchObject({
      status: 'planned',
      targetBranch: 'main',
      sourceBranch: 'feature/release',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('reconciles a concurrent PR creation after GitHub returns 422', async () => {
    const pullRequest = {
      number: 42,
      html_url: 'https://github.com/acme/project/pull/42',
      title: 'Release 1.9.0',
      state: 'open',
      base: { ref: 'main' },
      head: { ref: 'feature/release', sha },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/main')))
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/feature/release')))
      .mockResolvedValueOnce(response(200, JSON.stringify([])))
      .mockResolvedValueOnce(
        response(422, JSON.stringify({ message: 'A pull request already exists' })),
      )
      .mockResolvedValueOnce(response(200, JSON.stringify([pullRequest])));
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.createOrReusePullRequest({
        repository: 'acme/project',
        targetBranch: 'main',
        sourceBranch: 'feature/release',
        releaseTag: '1.9.0',
        mode: 'apply',
        sideEffectGate: 'release-gate-' + 'x'.repeat(20),
        config: config(),
      }),
    ).resolves.toMatchObject({ status: 'reused', pullRequest: { number: 42, headSha: sha } });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'GET',
      'GET',
      'GET',
      'POST',
      'GET',
    ]);
  });

  it('does not reconcile an unrelated GitHub 422 validation error', async () => {
    const pullRequest = {
      number: 42,
      html_url: 'https://github.com/acme/project/pull/42',
      title: 'Release 1.9.0',
      state: 'open',
      base: { ref: 'main' },
      head: { ref: 'feature/release', sha },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/main')))
      .mockResolvedValueOnce(response(200, refResponse('refs/heads/feature/release')))
      .mockResolvedValueOnce(response(200, JSON.stringify([])))
      .mockResolvedValueOnce(response(422, JSON.stringify({ message: 'Validation Failed' })));
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.createOrReusePullRequest({
        repository: 'acme/project',
        targetBranch: 'main',
        sourceBranch: 'feature/release',
        releaseTag: '1.9.0',
        mode: 'apply',
        sideEffectGate: 'release-gate-' + 'x'.repeat(20),
        config: config(),
      }),
    ).rejects.toThrow('HTTP 422');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'GET',
      'GET',
      'GET',
      'POST',
    ]);
    void pullRequest;
  });
  it('finds a matching merged PR across closed PR pages', async () => {
    const unrelatedPullRequests = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      html_url: `https://github.com/acme/project/pull/${index + 1}`,
      title:
        index === 0
          ? 'Release 1.9.0: feature/release -> main'
          : 'Release another-version: feature/release -> main',
      state: 'closed',
      merged_at: index === 0 ? null : '2026-09-20T10:00:00Z',
      base: { ref: 'main' },
      head: { ref: 'feature/release', sha },
    }));
    const mergedPullRequest = {
      number: 101,
      html_url: 'https://github.com/acme/project/pull/101',
      title: 'Release 1.9.0: feature/release -> main',
      state: 'closed',
      merged_at: '2026-09-29T10:00:00Z',
      base: { ref: 'main' },
      head: { ref: 'feature/release', sha },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, JSON.stringify(unrelatedPullRequests)))
      .mockResolvedValueOnce(response(200, JSON.stringify([mergedPullRequest])));
    const github = new GitHubReleaseClientService({ config: config(), fetchImpl });
    const service = new ReleaseAutomationService(github, {} as never, {} as never, {} as never);

    await expect(
      service.findMergedPullRequest({
        repository: 'acme/project',
        sourceBranch: 'feature/release',
        targetBranch: 'main',
        releaseTag: '1.9.0',
        config: config(),
      }),
    ).resolves.toMatchObject({ number: 101, mergedAt: '2026-09-29T10:00:00Z' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('state')).toBe('closed');
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('page')).toBe('2');
  });

  it('fails closed when multiple merged PRs match the same release', async () => {
    const pullRequest = {
      number: 42,
      url: 'https://github.com/acme/project/pull/42',
      title: 'Release 1.9.0: feature/release -> main',
      state: 'closed' as const,
      mergedAt: '2026-09-29T10:00:00Z',
      baseBranch: 'main',
      headBranch: 'feature/release',
      headSha: sha,
    };
    const github = {
      listPullRequests: vi
        .fn()
        .mockResolvedValue([
          pullRequest,
          { ...pullRequest, number: 43, url: 'https://github.com/acme/project/pull/43' },
        ]),
    };
    const service = new ReleaseAutomationService(
      github as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.findMergedPullRequest({
        repository: 'acme/project',
        sourceBranch: 'feature/release',
        targetBranch: 'main',
        releaseTag: '1.9.0',
      }),
    ).rejects.toThrow('多个已合并 PR');
  });

  it('reads exact GitHub modify-log content without creating a local archive', async () => {
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
          currentBranch: 'feature/release',
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
      currentBranch: 'feature/release',
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
    ).resolves.toMatchObject({ sql: content, sourceChecksum: 'content-checksum', artifact: null });
    expect(gateway.readSource).toHaveBeenCalledWith({
      repository: 'acme/project',
      ref: sha,
      config: runtimeConfig,
    });
    expect(archive.archive).not.toHaveBeenCalled();
  });

  it('falls back to the release source branch when no candidate SHA exists', async () => {
    const gateway = {
      readSource: vi.fn().mockResolvedValue({
        path: '.version/modify-log.sql',
        repository: 'acme/project',
        ref: 'feature/release',
        blobSha: 'blob-sha',
        checksum: 'content-checksum',
        generation: 'feature/release:blob-sha',
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
      releaseUnit: {
        repository: 'acme/project',
        currentBranch: 'feature/release',
        targetBranch: 'main',
        version: '1.9.0',
      },
      mode: 'dry-run',
      config: config(),
    });
    expect(gateway.readSource).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'acme/project', ref: 'feature/release' }),
    );
    expect(archive.archive).not.toHaveBeenCalled();
  });
});
