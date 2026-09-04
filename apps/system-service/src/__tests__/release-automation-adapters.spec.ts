import { describe, expect, it, vi } from 'vitest';
import { GitHubReleaseClientService } from '../modules/release-automation/github-release-client.service';
import { RELEASE_AUTOMATION_TAG_PATTERN } from '../modules/release-automation/release-automation.constants';
import {
  JenkinsClientService,
  parsePipelineTag,
  parseQueueId,
} from '../modules/release-automation/jenkins-client.service';
import type { ReleaseAutomationConfig } from '../modules/release-automation/release-automation.config';

const sha = 'a'.repeat(40);

function config(overrides: Partial<ReleaseAutomationConfig> = {}): ReleaseAutomationConfig {
  return {
    version: '1.9.0',
    dryRun: true,
    githubBaseUrl: 'https://api.github.test',
    githubAllowedHosts: ['api.github.test'],
    githubAllowedRepositories: ['acme/project'],
    githubTokenRef: 'secret://github/token',
    githubTimeoutMs: 100,
    githubMaxRetries: 0,
    githubMaxResponseBytes: 100_000,
    modifyLogPath: 'modify-log.sql',
    modifyLogArchiveDir: 'var/archive',
    modifyLogMaxBytes: 100_000,
    modifyLogMaxLines: 100,
    jenkinsBaseUrl: 'http://jenkins.test:8080',
    jenkinsTriggerPath: '/job/package/buildWithParameters',
    jenkinsQueuePathTemplate: '/queue/item/{queueId}/api/json',
    jenkinsBuildPathTemplate: '/job/package/{buildNumber}/api/json',
    jenkinsPipelineTextPathTemplate: '/job/package/{buildNumber}/pipeline-text',
    jenkinsCredentialRef: 'secret://jenkins/credential',
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
      secretProvider: { resolve: vi.fn().mockResolvedValue('sentinel') },
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
    expect(parsePipelineTag(text)).toBe('1.9.0');
    expect(RELEASE_AUTOMATION_TAG_PATTERN.test('1.9.0')).toBe(true);
    expect(() => parsePipelineTag('backend-wzj-nodejs-v2: 1.9.0\nFinished: FAILURE')).toThrow(
      'Finished: SUCCESS',
    );
  });

  it('does not verify a successful build without a source SHA', async () => {
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
      );
    const client = new JenkinsClientService({
      config: config(),
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      secretProvider: { resolve: vi.fn().mockResolvedValue('Authorization sentinel') },
    });

    await expect(
      client.package({
        releaseUnit: {
          repository: 'acme/project',
          targetBranch: 'custom/prod',
          candidateSha: sha,
          version: '1.9.0',
        },
        planHash: 'b'.repeat(64),
        mode: 'apply',
        sideEffectGate: 'gate-' + 'x'.repeat(20),
      }),
    ).resolves.toMatchObject({ status: 'manual-intervention', queueId: '779', buildNumber: 889 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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
      secretProvider: { resolve: vi.fn().mockResolvedValue('Authorization sentinel') },
    });

    await expect(
      client.package({
        releaseUnit: {
          repository: 'acme/project',
          targetBranch: 'custom/prod',
          candidateSha: sha,
          version: '1.9.0',
        },
        planHash: 'b'.repeat(64),
        mode: 'apply',
        sideEffectGate: 'gate-' + 'x'.repeat(20),
      }),
    ).rejects.toThrow('number');
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
      secretProvider: { resolve: vi.fn().mockResolvedValue('Authorization sentinel') },
    });
    const result = await client.package({
      releaseUnit: {
        repository: 'acme/project',
        targetBranch: 'custom/prod',
        candidateSha: sha,
        version: '1.9.0',
      },
      planHash: 'b'.repeat(64),
      mode: 'apply',
      sideEffectGate: 'gate-' + 'x'.repeat(20),
    });
    expect(result).toMatchObject({
      status: 'verified',
      queueId: '777',
      buildNumber: 888,
      pipelineTag: '1.9.0',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('Authorization sentinel');
  });
});
