import { describe, expect, it, vi } from 'vitest';
import { GitHubReleaseClientService } from '../modules/release-automation/github-release-client.service';
import {
  JenkinsClientService,
  parsePipelineTag,
  parseQueueId,
} from '../modules/release-automation/jenkins-client.service';
import type { ReleaseAutomationConfig } from '../modules/release-automation/release-automation.config';

const sha = 'a'.repeat(40);
const nonStandardSha = 'source sha / not hex';

function config(overrides: Partial<ReleaseAutomationConfig> = {}): ReleaseAutomationConfig {
  return {
    version: '1.9.0',
    githubBaseUrl: 'https://api.github.test',
    githubAllowedHosts: ['api.github.test'],
    githubToken: 'sentinel',
    githubTimeoutMs: 100,
    githubMaxRetries: 0,
    githubMaxResponseBytes: 100_000,
    modifyLogPath: 'modify-log.sql',
    modifyLogArchiveDir: 'var/archive',
    modifyLogMaxBytes: 100_000,
    modifyLogMaxLines: 100,
    jenkinsBaseUrl: 'http://jenkins.test:8080',
    jenkinsTagMarker: 'backend-wzj-nodejs-v2',
    jenkinsTriggerPath: '/job/package/buildWithParameters',
    jenkinsQueuePathTemplate: '/queue/item/{queueId}/api/json',
    jenkinsBuildPathTemplate: '/job/package/{buildNumber}/api/json',
    jenkinsPipelineTextPathTemplate: '/job/package/{buildNumber}/pipeline-text',
    jenkinsToken: 'sentinel',
    jenkinsTimeoutMs: 100,
    jenkinsMaxRetries: 0,
    jenkinsPollIntervalMs: 1,
    jenkinsQueueTimeoutMs: 1000,
    jenkinsBuildTimeoutMs: 1000,
    redisKeyPrefix: 'release-automation',
    ...overrides,
  };
}

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: vi.fn().mockResolvedValue(body),
  };
}

describe('release automation remote adapters', () => {
  it('does not call GitHub write endpoints in dry-run', async () => {
    const fetchImpl = vi.fn();
    const client = new GitHubReleaseClientService({
      config: config(),
      fetchImpl,
    });
    await expect(
      client.merge({
        repository: 'acme/project',
        base: 'custom/prod',
        head: 'dev',
        message: 'Release 1.9.0',
        mode: 'dry-run',
      }),
    ).rejects.toThrow('apply gate');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('performs guarded GitHub merge and tag writes with runtime credentials', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(201, JSON.stringify({ sha })))
      .mockResolvedValueOnce(
        response(
          201,
          JSON.stringify({
            ref: 'refs/tags/release/版本 with spaces',
            object: { sha: nonStandardSha, type: 'commit' },
          }),
        ),
      );
    const client = new GitHubReleaseClientService({
      config: config({ githubToken: 'runtime-token' }),
      fetchImpl,
    });

    await expect(
      client.merge({
        repository: 'acme/project',
        base: 'main',
        head: 'dev/master',
        message: 'Merge dev/master into main for Release Version 1.9.0',
        mode: 'apply',
        sideEffectGate: 'gate-' + 'x'.repeat(20),
      }),
    ).resolves.toMatchObject({ status: 'merged', sha });
    await expect(
      client.createTag({
        repository: 'acme/project',
        tag: 'release/版本 with spaces',
        sha: nonStandardSha,
        mode: 'apply',
        sideEffectGate: 'gate-' + 'x'.repeat(20),
      }),
    ).resolves.toMatchObject({
      ref: 'refs/tags/release/版本 with spaces',
      sha: nonStandardSha,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer runtime-token' }),
    });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer runtime-token' }),
    });
  });

  it('reads tag order and compares the adjacent release tags', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify([
            { name: 'release/current', commit: { sha: 'current-sha' } },
            { name: 'release/previous', commit: { sha: 'previous-sha' } },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify({
            commits: [
              {
                sha: 'commit-sha',
                commit: {
                  message: 'feat: release fact',
                  author: { name: 'author', date: '2026-01-01T00:00:00Z' },
                },
                parents: [{ sha: 'parent' }],
              },
            ],
          }),
        ),
      );
    const client = new GitHubReleaseClientService({ config: config(), fetchImpl });

    await expect(
      client.listTags({ repository: 'acme/project', config: config() }),
    ).resolves.toEqual([
      { name: 'release/current', sha: 'current-sha' },
      { name: 'release/previous', sha: 'previous-sha' },
    ]);
    await expect(
      client.compareCommits({
        repository: 'acme/project',
        base: 'tags/release/previous',
        head: 'tags/release/current',
        config: config(),
      }),
    ).resolves.toMatchObject([{ sha: 'commit-sha', isMerge: false }]);
  });

  it('reads repository files through the GitHub Contents API', async () => {
    const content = 'ALTER TABLE release_marker ADD COLUMN ready TINYINT;\n';
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        200,
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(content, 'utf8').toString('base64'),
          sha: 'blob-sha',
        }),
      ),
    );
    const client = new GitHubReleaseClientService({ config: config(), fetchImpl });

    await expect(
      client.getContents(
        { repository: 'acme/project', path: '.version/modify-log.sql', ref: 'candidate sha' },
        config(),
      ),
    ).resolves.toMatchObject({
      content,
      sha: 'blob-sha',
      ref: 'candidate sha',
      repository: 'acme/project',
    });
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/repos/acme/project/contents/.version/modify-log.sql?ref=candidate%20sha',
    );
  });

  it('passes opaque repository and ref values through encoded GitHub paths', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response(
          200,
          JSON.stringify({ ref: 'refs/heads/opaque ref', object: { sha: 'opaque sha' } }),
        ),
      );
    const client = new GitHubReleaseClientService({ config: config(), fetchImpl });

    await expect(
      client.getRef('owner/repo with spaces', 'branch/with spaces', config()),
    ).resolves.toMatchObject({ ref: 'refs/heads/opaque ref', sha: 'opaque sha' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/repos/owner/repo%20with%20spaces/git/ref/branch/with%20spaces',
    );
  });

  it('accepts only a same-origin dynamic queue Location', () => {
    expect(
      parseQueueId('http://jenkins.test:8080/queue/item/777/', 'http://jenkins.test:8080'),
    ).toBe('777');
    expect(() =>
      parseQueueId('http://other.test/queue/item/777/', 'http://jenkins.test:8080'),
    ).toThrow('Location');
    expect(() =>
      parseQueueId('http://jenkins.test:8080/queue/item/777?x=1', 'http://jenkins.test:8080'),
    ).toThrow('Location');
  });

  it('parses the final successful Pipeline tag from the last marker', () => {
    const text = [
      'backend-wzj-nodejs-v2: 1.9.0-old',
      'backend-wzj-nodejs-v2: 1.9.0',
      '',
      'Finished: SUCCESS',
      '',
    ].join('\n');
    expect(parsePipelineTag(text, 'backend-wzj-nodejs-v2')).toBe('1.9.0');
    expect(
      parsePipelineTag(
        'backend-wzj-nodejs-v2: release tag / 非标准\nFinished: SUCCESS',
        'backend-wzj-nodejs-v2',
      ),
    ).toBe('release tag / 非标准');
    expect(
      parsePipelineTag(
        '+ docker push registry.cn-hangzhou.aliyuncs.com/weizhujiao/backend-wzj-nodejs-v2:x86_dev_master_0e98b10ef6_v1.9.0-2026-09-04\nFinished: SUCCESS',
        'backend-wzj-nodejs-v2',
      ),
    ).toBe('x86_dev_master_0e98b10ef6_v1.9.0-2026-09-04');
    expect(() =>
      parsePipelineTag('backend-wzj-nodejs-v2: 1.9.0\nFinished: FAILURE', 'backend-wzj-nodejs-v2'),
    ).toThrow('Finished: SUCCESS');
  });

  it('does not require a source SHA to package with Jenkins', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(201, '', { Location: 'http://jenkins.test:8080/queue/item/779/' }),
      )
      .mockResolvedValueOnce(response(200, JSON.stringify({ executable: { number: 889 } })))
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify({
            queueId: 779,
            number: 889,
            building: false,
            result: 'SUCCESS',
            actions: [],
          }),
        ),
      )
      .mockResolvedValueOnce(response(200, 'backend-wzj-nodejs-v2: 1.9.0\nFinished: SUCCESS\n'));
    const client = new JenkinsClientService({
      config: config(),
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(client.package()).resolves.toMatchObject({
      status: 'verified',
      queueId: '779',
      buildNumber: 889,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('rejects a build response without the executable build number', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(201, '', { Location: 'http://jenkins.test:8080/queue/item/780/' }),
      )
      .mockResolvedValueOnce(response(200, JSON.stringify({ executable: { number: 890 } })))
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify({
            queueId: 780,
            building: false,
            result: 'SUCCESS',
            actions: [{ lastBuiltRevision: { SHA1: sha } }],
          }),
        ),
      );
    const client = new JenkinsClientService({
      config: config(),
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(client.package()).rejects.toThrow('number');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('uses the trigger Location and executable number, never fixed example ids', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(201, '', { Location: 'http://jenkins.test:8080/queue/item/777/' }),
      )
      .mockResolvedValueOnce(
        response(200, JSON.stringify({ executable: null, blocked: true, why: 'busy' })),
      )
      .mockResolvedValueOnce(
        response(200, JSON.stringify({ executable: { number: 888 }, id: 777 })),
      )
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify({
            queueId: 777,
            number: 888,
            building: false,
            result: 'SUCCESS',
            actions: [{ lastBuiltRevision: { SHA1: sha } }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        response(200, 'old\nbackend-wzj-nodejs-v2: 1.9.0\nFinished: SUCCESS\n'),
      );
    const client = new JenkinsClientService({
      config: config(),
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const result = await client.package(
      config({
        jenkinsTriggerPath: '/job/override/buildWithParameters',
        jenkinsToken: 'runtime-token',
      }),
    );
    expect(result).toMatchObject({
      status: 'verified',
      queueId: '777',
      buildNumber: 888,
      pipelineTag: '1.9.0',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('Authorization sentinel');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/job/override/buildWithParameters');
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('root:runtime-token').toString('base64')}`,
    });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('skipTest=true');
  });
});
