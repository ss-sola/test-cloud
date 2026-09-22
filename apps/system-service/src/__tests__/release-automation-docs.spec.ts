import { describe, expect, it, vi } from 'vitest';
import { ReleaseDocsService } from '../modules/release-automation/release-docs.service';
import type { ReleaseAutomationConfig } from '../modules/release-automation/release-automation.config';

const config = {
  version: '1.9.0',
  githubBaseUrl: 'https://api.github.test',
  githubAllowedHosts: ['api.github.test'],
  githubToken: 'github-token',
  githubTimeoutMs: 100,
  githubMaxRetries: 0,
  githubMaxResponseBytes: 100_000,
  modifyLogPath: 'modify-log.sql',
  modifyLogArchiveDir: 'var/archive',
  modifyLogMaxBytes: 100_000,
  modifyLogMaxLines: 100,
  environmentFilePath: 'env/app.env',
  jenkinsTimeoutMs: 100,
  jenkinsMaxRetries: 0,
  jenkinsPollIntervalMs: 1,
  jenkinsQueueTimeoutMs: 100,
  jenkinsBuildTimeoutMs: 100,
  redisKeyPrefix: 'release-automation',
} satisfies ReleaseAutomationConfig;

function releaseUnit() {
  return {
    repository: 'acme/project',
    targetBranch: 'release/ref',
    gitTag: 'release/ref',
    version: 'release/ref',
  };
}

function createReleaseService() {
  return {
    getEnvironmentDiff: vi.fn().mockResolvedValue({
      filePath: 'env/app.env',
      diff: { changed: [{ key: 'FEATURE_X' }], beforeChecksum: 'before', afterChecksum: 'after' },
    }),
    prepareModifyLog: vi.fn().mockResolvedValue({
      sourceChecksum: 'source',
      generation: 'generation',
      recordCount: 2,
      sql: '-- sql',
      artifact: null,
    }),
  };
}

function createGithub(
  commits: unknown[],
  tags = [
    { name: 'release/ref', sha: 'current-sha' },
    { name: 'release/previous', sha: 'previous-sha' },
  ],
) {
  return {
    listTags: vi.fn().mockResolvedValue(tags),
    compareCommits: vi.fn().mockResolvedValue(commits),
    listCommits: vi.fn().mockResolvedValue(commits),
    getContents: vi.fn().mockResolvedValue({
      content: 'FEATURE_ENABLED=true\n',
      checksum: 'environment-checksum',
    }),
    putContents: vi.fn().mockResolvedValue({
      status: 'created',
      path: 'update-log/release_previous-release_ref.md',
      branch: 'release/ref',
      commitSha: 'update-commit',
    }),
  };
}

describe('release docs generation', () => {
  it('uses the previous GitHub tag and never filters by author', async () => {
    const github = createGithub([
      {
        sha: 'abc123',
        message: 'feat: improve release flow',
        author: 'someone@example.com',
        date: '2026-01-02T00:00:00Z',
        isMerge: false,
      },
      {
        sha: 'merge123',
        message: 'Merge branch',
        author: 'another@example.com',
        date: '2026-01-03T00:00:00Z',
        isMerge: true,
      },
    ]);
    const ai = {
      request: vi.fn().mockResolvedValue(
        JSON.stringify({
          summary: [{ text: '完成发布流程改进', factRefs: ['commit:abc123'] }],
        }),
      ),
    };
    const releaseService = createReleaseService();
    const service = new ReleaseDocsService(github as never, releaseService as never, ai as never);

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      runtime: { ai: { baseUrl: 'https://ai.example.com/v1', apiKey: 'secret', model: 'model' } },
      input: {},
    });

    expect(result.status).toBe('succeeded');
    expect(result.degraded).toBe(false);
    expect(result.previousTag).toBe('release/previous');
    expect(result.currentTag).toBe('release/ref');
    expect(result.markdown).toContain('完成发布流程改进');
    expect(result.commitCount).toBe(2);
    expect(result.mergeCommitCount).toBe(1);
    expect(github.compareCommits).toHaveBeenCalledWith({
      repository: 'acme/project',
      base: 'tags/release/previous',
      head: 'tags/release/ref',
      config,
    });
    expect(github.compareCommits.mock.calls[0][0]).not.toHaveProperty('author');
    expect(ai.request).toHaveBeenCalledTimes(1);
    expect(ai.request.mock.calls[0][0]).toMatchObject({ timeoutMs: 300_000 });
  });

  it('writes complete facts to a GitHub update-log on apply', async () => {
    const github = createGithub([
      { sha: 'abc123', message: 'feat: update', author: null, date: null, isMerge: false },
    ]);
    github.getContents
      .mockReset()
      .mockResolvedValueOnce({ content: 'FEATURE_ENABLED=true\n', checksum: 'after-env' })
      .mockResolvedValueOnce({ content: 'FEATURE_ENABLED=false\n', checksum: 'before-env' });
    const releaseService = createReleaseService();
    const progressMessages: string[] = [];
    const service = new ReleaseDocsService(
      github as never,
      releaseService as never,
      { request: vi.fn() } as never,
    );

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      input: {},
      runtime: { ai: { baseUrl: 'https://ai.example.com/v1', apiKey: 'secret', model: 'model' } },
      publish: { mode: 'apply', sideEffectGate: 'gate-' + 'x'.repeat(20) },
      progress: async (message) => {
        progressMessages.push(message);
      },
    });

    expect(result.publication).toMatchObject({
      status: 'created',
      path: 'update-log/release_previous-release_ref.md',
      branch: 'release/ref',
      commitSha: 'update-commit',
    });
    expect(progressMessages).toContain('正在通过 GitHub API 获取两个 tag 之间的提交记录。');
    expect(progressMessages).toContain('正在调用 AI 整理提交、环境差异和 modify-log。');
    expect(result.markdown).toContain('# release/previous-release/ref');
    expect(result.markdown).toContain('## 各服务版本对应关系');
    expect(result.markdown).toContain('## 各服务迁移SQL');
    expect(result.markdown).toContain('## 各服务迁移环境变量');
    expect(result.markdown).toContain('## 更新内容(测试人员)');
    expect(result.markdown).toContain('FEATURE_ENABLED');
    expect(result.markdown).not.toContain('- modify-log.sql');
    expect(result.markdown).not.toContain('- env/app.env');
    expect(result.markdown).toContain('```sql');
    expect(result.markdown).toContain('-- sql');
    expect(github.putContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'update-log/release_previous-release_ref.md',
        branch: 'release/ref',
        content: result.markdown,
        mode: 'apply',
      }),
      config,
    );
  });

  it('does not write an update-log during dry-run generation', async () => {
    const github = createGithub([]);
    const releaseService = createReleaseService();
    const service = new ReleaseDocsService(
      github as never,
      releaseService as never,
      { request: vi.fn() } as never,
    );

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      input: {},
      publish: { mode: 'dry-run', sideEffectGate: '' },
    });

    expect(result.publication).toMatchObject({
      status: 'planned',
      path: 'update-log/release_previous-release_ref.md',
    });
    expect(github.putContents).not.toHaveBeenCalled();
  });

  it('falls back to the local summary when AI is not configured', async () => {
    const github = createGithub([
      {
        sha: 'abc123',
        message: 'fix: local fallback works',
        author: null,
        date: null,
        isMerge: false,
      },
    ]);
    const releaseService = createReleaseService();
    const ai = { request: vi.fn() };
    const service = new ReleaseDocsService(github as never, releaseService as never, ai as never);

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      input: {},
    });

    expect(result.status).toBe('degraded');
    expect(result.degraded).toBe(true);
    expect(result.markdown).toContain('local fallback works');
    expect(result.warnings).toContain('未配置 AI，使用本地发布摘要。');
    expect(ai.request).not.toHaveBeenCalled();
  });

  it('rejects AI output that references unknown facts', async () => {
    const github = createGithub([
      { sha: 'abc123', message: 'feat: fact', author: null, date: null, isMerge: false },
    ]);
    const ai = {
      request: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ summary: [{ text: '编造内容', factRefs: ['commit:missing'] }] }),
        ),
    };
    const releaseService = createReleaseService();
    const service = new ReleaseDocsService(github as never, releaseService as never, ai as never);

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      runtime: { ai: { baseUrl: 'https://ai.example.com/v1', apiKey: 'secret', model: 'model' } },
      input: {},
    });

    expect(result.degraded).toBe(true);
    expect(result.markdown).not.toContain('编造内容');
    expect(result.warnings).toContain('AI 返回内容不符合事实引用格式，使用本地发布摘要。');
  });

  it('treats a tag without a predecessor as the first release', async () => {
    const github = createGithub(
      [{ sha: 'first-commit', message: 'feat: first release', author: null, date: null }],
      [{ name: 'release/ref', sha: 'current-sha' }],
    );
    const releaseService = createReleaseService();
    const service = new ReleaseDocsService(
      github as never,
      releaseService as never,
      { request: vi.fn() } as never,
    );

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      input: {},
    });

    expect(result.previousTag).toBeUndefined();
    expect(result.markdown).toContain('# initial-release/ref');
    expect(github.compareCommits).not.toHaveBeenCalled();
  });
});
