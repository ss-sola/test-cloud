import { describe, expect, it, vi } from 'vitest';
import { ReleaseDocsService } from '../modules/release-automation/release-docs.service';
import { sha256, stableStringify } from '../modules/release-automation/release-automation.security';
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
  environmentToSql: false,
  jenkinsTimeoutMs: 100,
  jenkinsMaxRetries: 0,
  jenkinsPollIntervalMs: 1,
  jenkinsQueueTimeoutMs: 100,
  jenkinsBuildTimeoutMs: 100,
  redisKeyPrefix: 'release-automation',
} satisfies ReleaseAutomationConfig;

const UPDATE_LOG_PATH = 'update-log/release_previous-release_ref.md';
const APPLY_GATE = 'gate-' + 'x'.repeat(20);

function updateLogWriteMessage(runId: string): string {
  const releaseKey = sha256(stableStringify(['release/previous', 'release/ref'])).slice(0, 16);
  return `docs: update log release_previous -> release_ref [NestCloud-RA:UpdateLog:v1:${sha256(UPDATE_LOG_PATH).slice(0, 12)}:${releaseKey}:${runId}]`;
}

function contents(content: string, sha: string) {
  return { content, sha, checksum: sha256(content) };
}

function releaseUnit() {
  return {
    repository: 'acme/project',
    currentBranch: 'feature/release',
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
    listCommits: vi.fn((options: { path?: string }) =>
      Promise.resolve(options.path ? [] : commits),
    ),
    getCommitDetails: vi.fn(),
    getRef: vi.fn().mockResolvedValue({
      ref: 'refs/heads/feature/release',
      sha: 'branch-head',
      objectType: 'commit',
    }),
    createBlob: vi.fn().mockResolvedValue({ sha: 'new-blob' }),
    createTree: vi.fn().mockResolvedValue({ sha: 'new-tree' }),
    createCommit: vi.fn().mockResolvedValue({ sha: 'new-commit' }),
    updateBranchRef: vi.fn().mockResolvedValue({
      ref: 'refs/heads/feature/release',
      sha: 'new-commit',
      objectType: 'commit',
    }),
    getContents: vi.fn().mockResolvedValue({
      content: 'FEATURE_ENABLED=true\n',
      checksum: 'environment-checksum',
    }),
    putContents: vi.fn().mockResolvedValue({
      status: 'created',
      path: 'update-log/release_previous-release_ref.md',
      branch: 'feature/release',
      commitSha: 'update-commit',
      blobSha: 'update-blob',
      checksum: 'update-checksum',
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
    const envSection =
      result.markdown.split('## 各服务迁移环境变量\n')[1]?.split('\n## 更新内容(测试人员)')[0] ??
      '';
    expect(envSection.match(/```/g)).toHaveLength(6);
    expect(envSection).toContain('无新增环境变量。');
    expect(envSection).toContain('无减少环境变量。');
    expect(envSection).toContain('无修改环境变量。');
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

  it('preserves ordinary punctuation and encodes source slashes in update content', async () => {
    const text = 'release v1.2.3 + config (stable) [details] _literal_ `code` api/path C:\\temp';
    const github = createGithub([
      { sha: 'abc123', message: 'feat: release text', author: null, date: null, isMerge: false },
    ]);
    const ai = {
      request: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ summary: [{ text, factRefs: ['commit:abc123'] }] })),
    };
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      ai as never,
    );

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      runtime: { ai: { baseUrl: 'https://ai.example.com/v1', apiKey: 'secret', model: 'model' } },
      input: {},
    });

    const updateSection = result.markdown.split('## 更新内容(测试人员)\n')[1] ?? '';
    expect(updateSection).toContain(
      '- release v1.2.3 + config (stable) &#91;details&#93; &#95;literal&#95; &#96;code&#96; api&#47;path C:&#92;temp',
    );
    expect(updateSection).not.toContain('\\');
    expect(updateSection).not.toContain('/');
  });

  it('uses pre-read modify-log SQL without fetching it again', async () => {
    const github = createGithub([]);
    const releaseService = createReleaseService();
    const modifyLog = {
      sourceChecksum: 'prepared-checksum',
      generation: 'prepared-generation',
      recordCount: 1,
      sql: 'INSERT INTO migration_log (id) VALUES (1);',
      sourcePath: '.version/modify-log.sql',
      sourceRef: 'candidate-sha',
      sourceBlobSha: 'modify-log-blob',
      artifact: null,
    };
    const service = new ReleaseDocsService(
      github as never,
      releaseService as never,
      { request: vi.fn() } as never,
    );
    const progressMessages: string[] = [];

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      input: {},
      modifyLog,
      progress: async (message) => {
        progressMessages.push(message);
      },
    });

    expect(releaseService.prepareModifyLog).not.toHaveBeenCalled();
    expect(result.database).toMatchObject({
      recordCount: 1,
      sourceChecksum: 'prepared-checksum',
      path: '.version/modify-log.sql',
      ref: 'candidate-sha',
      blobSha: 'modify-log-blob',
    });
    expect(result.markdown).toContain('INSERT INTO migration_log (id) VALUES (1);');
    expect(progressMessages).toContain('正在使用已读取的 modify-log SQL。');
    expect(progressMessages).not.toContain('正在从 GitHub 读取 modify-log.sql。');
  });

  it('writes complete facts to a GitHub update-log on apply', async () => {
    const github = createGithub([
      { sha: 'abc123', message: 'feat: update', author: null, date: null, isMerge: false },
    ]);
    github.getContents
      .mockReset()
      .mockResolvedValueOnce({
        content: 'FEATURE_ENABLED=true\nNEW_PORT=3000\n',
        checksum: 'after-env',
      })
      .mockResolvedValueOnce({
        content: 'FEATURE_ENABLED=false\nREMOVED=yes\n',
        checksum: 'before-env',
      });
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
      branch: 'feature/release',
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
    const envSection =
      result.markdown.split('## 各服务迁移环境变量\n')[1]?.split('\n## 更新内容(测试人员)')[0] ??
      '';
    expect(envSection).toContain('### 新增');
    expect(envSection).toContain('NEW_PORT=3000');
    expect(envSection).toContain('### 减少');
    expect(envSection).toContain('REMOVED=yes');
    expect(envSection).toContain('### 修改');
    expect(envSection).toContain('- FEATURE_ENABLED=false\n+ FEATURE_ENABLED=true');
    expect(envSection.match(/```/g)).toHaveLength(6);
    expect(envSection).not.toContain('env → sys_config');
    expect(result.markdown).not.toContain('- modify-log.sql');
    expect(result.markdown).not.toContain('- env/app.env');
    expect(result.markdown).toContain('```sql');
    expect(result.markdown).toContain('-- sql');
    expect(github.putContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'update-log/release_previous-release_ref.md',
        branch: 'feature/release',
        content: result.markdown,
        mode: 'apply',
        expectedBlobSha: null,
      }),
      config,
    );
  });

  it('replaces a legacy automation tip with one Git Data commit', async () => {
    const preview = await new ReleaseDocsService(
      createGithub([]) as never,
      createReleaseService() as never,
      { request: vi.fn() } as never,
    ).generate({ repository: 'acme/project', releaseUnit: releaseUnit(), config, input: {} });
    const legacyMessage = 'docs: update log release_previous -> release_ref';
    const github = createGithub([
      { sha: 'automation-sha', message: legacyMessage, author: null, date: null, isMerge: false },
    ]);
    github.listCommits.mockResolvedValueOnce([
      { sha: 'automation-sha', message: legacyMessage, author: null, date: null, isMerge: false },
    ]);
    github.compareCommits.mockResolvedValue([]);
    github.getCommitDetails
      .mockResolvedValueOnce({
        sha: 'automation-sha',
        message: legacyMessage,
        treeSha: 'automation-tree',
        parents: ['parent-sha'],
        files: [{ path: UPDATE_LOG_PATH, sha: 'current-blob', status: 'modified' }],
      })
      .mockResolvedValueOnce({
        sha: 'parent-sha',
        message: 'previous release commit',
        treeSha: 'parent-tree',
        parents: ['base-sha'],
        files: [],
      });
    github.getContents
      .mockReset()
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=true\n', 'env-current'))
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=true\n', 'env-previous'))
      .mockResolvedValueOnce(contents(preview.markdown, 'current-blob'));
    github.getRef.mockResolvedValueOnce({
      ref: 'refs/heads/feature/release',
      sha: 'automation-sha',
      objectType: 'commit',
    });
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      { request: vi.fn() } as never,
    );

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      input: {},
      publish: { mode: 'apply', sideEffectGate: APPLY_GATE },
    });

    expect(result.markdown).toBe(preview.markdown);
    expect(result.publication).toMatchObject({ status: 'updated', commitSha: 'new-commit' });
    expect(github.createBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'acme/project',
        content: preview.markdown,
        mode: 'apply',
      }),
      config,
    );
    expect(github.createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        baseTreeSha: 'parent-tree',
        path: UPDATE_LOG_PATH,
        blobSha: 'new-blob',
        mode: 'apply',
      }),
      config,
    );
    expect(github.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('NestCloud-RA:UpdateLog'),
        treeSha: 'new-tree',
        parentSha: 'parent-sha',
        mode: 'apply',
      }),
      config,
    );
    expect(github.updateBranchRef).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/release',
        sha: 'new-commit',
        expectedSha: 'automation-sha',
        mode: 'apply',
      }),
      config,
    );
    expect(github.putContents).not.toHaveBeenCalled();
  });

  it('does not revert a latest manual update-log commit', async () => {
    const message = `manual: edit update-log\n\n${updateLogWriteMessage(sha256(APPLY_GATE).slice(0, 16))}`;
    const github = createGithub([{ sha: 'manual-sha', message, author: null, date: null }]);
    github.listCommits.mockResolvedValueOnce([
      { sha: 'manual-sha', message, author: null, date: null },
    ]);
    github.getCommitDetails.mockResolvedValueOnce({
      sha: 'manual-sha',
      message,
      parents: ['parent-sha'],
      files: [{ path: UPDATE_LOG_PATH, sha: 'manual-blob', status: 'modified' }],
    });
    github.getContents
      .mockReset()
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=true\n', 'env-current'))
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=false\n', 'env-previous'));
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      { request: vi.fn() } as never,
    );

    await expect(
      service.generate({
        repository: 'acme/project',
        releaseUnit: releaseUnit(),
        config,
        input: {},
        publish: { mode: 'apply', sideEffectGate: APPLY_GATE },
      }),
    ).rejects.toThrow('无法确认由发布流程生成');
    expect(github.putContents).not.toHaveBeenCalled();
    expect(github.createBlob).not.toHaveBeenCalled();
    expect(github.createTree).not.toHaveBeenCalled();
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.updateBranchRef).not.toHaveBeenCalled();
  });

  it('rejects a legacy path collision when raw release tags differ', async () => {
    const legacyMessage = 'docs: update log release_previous -> release_ref';
    const tags = [
      { name: 'release_ref', sha: 'current-sha' },
      { name: 'release_previous', sha: 'previous-sha' },
    ];
    const github = createGithub([], tags);
    github.listCommits.mockResolvedValueOnce([
      { sha: 'legacy-sha', message: legacyMessage, author: null, date: null },
    ]);
    github.getCommitDetails.mockResolvedValueOnce({
      sha: 'legacy-sha',
      message: legacyMessage,
      treeSha: 'legacy-tree',
      parents: ['parent-sha'],
      files: [{ path: UPDATE_LOG_PATH, sha: 'legacy-blob', status: 'modified' }],
    });
    github.getContents
      .mockReset()
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=true\n', 'env-current'))
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=false\n', 'env-previous'))
      .mockResolvedValueOnce(contents('# release/previous-release/ref\n', 'legacy-blob'));
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      { request: vi.fn() } as never,
    );

    await expect(
      service.generate({
        repository: 'acme/project',
        releaseUnit: { ...releaseUnit(), gitTag: 'release_ref', version: 'release_ref' },
        config,
        input: {},
        publish: { mode: 'apply', sideEffectGate: APPLY_GATE },
      }),
    ).rejects.toThrow('内容与当前 release tag 不匹配');
    expect(github.createBlob).not.toHaveBeenCalled();
    expect(github.updateBranchRef).not.toHaveBeenCalled();
  });

  it('rejects legacy tags that normalize to an existing update-log path', async () => {
    const legacyMessage = 'docs: update log release_previous -> release_ref';
    const github = createGithub(
      [],
      [
        { name: 'release_ref', sha: 'current-sha' },
        { name: 'release_previous', sha: 'previous-sha' },
      ],
    );
    github.listCommits.mockResolvedValueOnce([
      { sha: 'legacy-sha', message: legacyMessage, author: null, date: null },
    ]);
    github.getCommitDetails.mockResolvedValueOnce({
      sha: 'legacy-sha',
      message: legacyMessage,
      treeSha: 'legacy-tree',
      parents: ['parent-sha'],
      files: [{ path: UPDATE_LOG_PATH, sha: 'legacy-blob', status: 'modified' }],
    });
    github.getContents
      .mockReset()
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=true\n', 'env-current'))
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=false\n', 'env-previous'))
      .mockResolvedValueOnce(contents('# release/previous-release/ref\n', 'legacy-blob'));
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      { request: vi.fn() } as never,
    );

    await expect(
      service.generate({
        repository: 'acme/project',
        releaseUnit: { ...releaseUnit(), gitTag: 'release_ref', version: 'release_ref' },
        config,
        input: {},
        publish: { mode: 'apply', sideEffectGate: APPLY_GATE },
      }),
    ).rejects.toThrow('内容与当前 release tag 不匹配');
    expect(github.createBlob).not.toHaveBeenCalled();
    expect(github.updateBranchRef).not.toHaveBeenCalled();
  });

  it('reuses the completed update-log commit for a retry of the same apply run', async () => {
    const runId = sha256(APPLY_GATE).slice(0, 16);
    const canonicalMarkdown = '# release/previous-release/ref\n\n## first attempt\n';
    const message = updateLogWriteMessage(runId);
    const github = createGithub([
      { sha: 'same-run-commit', message, author: null, date: null, isMerge: false },
    ]);
    github.listCommits.mockResolvedValueOnce([
      { sha: 'same-run-commit', message, author: null, date: null, isMerge: false },
    ]);
    github.getCommitDetails.mockResolvedValueOnce({
      sha: 'same-run-commit',
      message,
      treeSha: 'same-run-tree',
      parents: ['parent-sha'],
      files: [{ path: UPDATE_LOG_PATH, sha: 'current-blob', status: 'modified' }],
    });
    github.getRef.mockResolvedValueOnce({
      ref: 'refs/heads/feature/release',
      sha: 'same-run-commit',
      objectType: 'commit',
    });
    github.getContents
      .mockReset()
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=true\n', 'env-current'))
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=false\n', 'env-previous'))
      .mockResolvedValueOnce(contents(canonicalMarkdown, 'current-blob'));
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      { request: vi.fn() } as never,
    );

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      input: {},
      publish: { mode: 'apply', sideEffectGate: APPLY_GATE },
    });

    expect(result.publication).toMatchObject({
      status: 'unchanged',
      commitSha: 'same-run-commit',
    });
    expect(result.markdown).toBe(canonicalMarkdown);
    expect(result.markdownChecksum).toBe(sha256(canonicalMarkdown));
    expect(github.putContents).not.toHaveBeenCalled();
    expect(github.createBlob).not.toHaveBeenCalled();
    expect(github.createTree).not.toHaveBeenCalled();
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.updateBranchRef).not.toHaveBeenCalled();
  });

  it('does not revert a legacy-looking commit that changed more than update-log', async () => {
    const legacyMessage = 'docs: update log release_previous -> release_ref';
    const github = createGithub([]);
    github.listCommits.mockResolvedValueOnce([
      { sha: 'multi-file-sha', message: legacyMessage, author: null, date: null },
    ]);
    github.getCommitDetails.mockResolvedValueOnce({
      sha: 'multi-file-sha',
      message: legacyMessage,
      parents: ['parent-sha'],
      files: [
        { path: UPDATE_LOG_PATH, sha: 'update-log-blob', status: 'modified' },
        { path: 'README.md', sha: 'readme-blob', status: 'modified' },
      ],
    });
    github.getContents
      .mockReset()
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=true\n', 'env-current'))
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=false\n', 'env-previous'));
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      { request: vi.fn() } as never,
    );

    await expect(
      service.generate({
        repository: 'acme/project',
        releaseUnit: releaseUnit(),
        config,
        input: {},
        publish: { mode: 'apply', sideEffectGate: APPLY_GATE },
      }),
    ).rejects.toThrow('包含其它文件');
    expect(github.putContents).not.toHaveBeenCalled();
    expect(github.createBlob).not.toHaveBeenCalled();
    expect(github.createTree).not.toHaveBeenCalled();
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.updateBranchRef).not.toHaveBeenCalled();
  });

  it('fails closed when a later source-branch commit follows the update-log commit', async () => {
    const legacyMessage = 'docs: update log release_previous -> release_ref';
    const github = createGithub([]);
    github.listCommits.mockResolvedValueOnce([
      { sha: 'automation-sha', message: legacyMessage, author: null, date: null },
    ]);
    github.getCommitDetails.mockResolvedValueOnce({
      sha: 'automation-sha',
      message: legacyMessage,
      treeSha: 'automation-tree',
      parents: ['parent-sha'],
      files: [{ path: UPDATE_LOG_PATH, sha: 'update-log-blob', status: 'modified' }],
    });
    github.getContents
      .mockReset()
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=true\n', 'env-current'))
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=false\n', 'env-previous'))
      .mockResolvedValueOnce(
        contents('# release/previous-release/ref\n# existing update-log\n', 'update-log-blob'),
      );
    github.getRef.mockResolvedValueOnce({
      ref: 'refs/heads/feature/release',
      sha: 'later-manual-head',
      objectType: 'commit',
    });
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      { request: vi.fn() } as never,
    );

    await expect(
      service.generate({
        repository: 'acme/project',
        releaseUnit: releaseUnit(),
        config,
        input: {},
        publish: { mode: 'apply', sideEffectGate: APPLY_GATE },
      }),
    ).rejects.toThrow('不是 source branch HEAD');
    expect(github.createBlob).not.toHaveBeenCalled();
    expect(github.createTree).not.toHaveBeenCalled();
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.updateBranchRef).not.toHaveBeenCalled();
  });

  it('replaces an added update-log commit using its parent tree', async () => {
    const legacyMessage = 'docs: update log release_previous -> release_ref';
    const github = createGithub([]);
    github.listCommits.mockResolvedValueOnce([
      { sha: 'automation-sha', message: legacyMessage, author: null, date: null },
    ]);
    github.getCommitDetails
      .mockResolvedValueOnce({
        sha: 'automation-sha',
        message: legacyMessage,
        treeSha: 'automation-tree',
        parents: ['parent-sha'],
        files: [{ path: UPDATE_LOG_PATH, sha: 'added-blob', status: 'added' }],
      })
      .mockResolvedValueOnce({
        sha: 'parent-sha',
        message: 'previous release',
        treeSha: 'parent-tree',
        parents: ['base-sha'],
        files: [],
      });
    github.getContents
      .mockReset()
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=true\n', 'env-current'))
      .mockResolvedValueOnce(contents('FEATURE_ENABLED=false\n', 'env-previous'))
      .mockResolvedValueOnce(
        contents('# release/previous-release/ref\n# initial update-log\n', 'added-blob'),
      );
    github.getRef.mockResolvedValueOnce({
      ref: 'refs/heads/feature/release',
      sha: 'automation-sha',
      objectType: 'commit',
    });
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      { request: vi.fn() } as never,
    );

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config,
      input: {},
      publish: { mode: 'apply', sideEffectGate: APPLY_GATE },
    });

    expect(result.publication).toMatchObject({ status: 'updated', commitSha: 'new-commit' });
    expect(github.createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        baseTreeSha: 'parent-tree',
        path: UPDATE_LOG_PATH,
        blobSha: 'new-blob',
      }),
      config,
    );
    expect(github.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ treeSha: 'new-tree', parentSha: 'parent-sha' }),
      config,
    );
    expect(github.updateBranchRef).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/release',
        sha: 'new-commit',
        expectedSha: 'automation-sha',
      }),
      config,
    );
    expect(github.putContents).not.toHaveBeenCalled();
  });

  it('publishes only changed env config rows without exposing them to AI', async () => {
    const github = createGithub([]);
    github.getContents
      .mockReset()
      .mockResolvedValueOnce({
        content:
          '# Application name\n# Shown in the release UI\nAPP_NAME=new\nNEW_PORT=3000\nAPI_TOKEN=latest-secret\nPATH=C:\\release/v1\nSAME=stable\n',
        checksum: 'after-env',
      })
      .mockResolvedValueOnce({
        content: 'APP_NAME=old\nAPI_TOKEN=old-secret\nSAME=stable\nREMOVED=yes\n',
        checksum: 'before-env',
      });
    const ai = {
      request: vi.fn().mockResolvedValue(JSON.stringify({ summary: [] })),
    };
    const releaseConfig = { ...config, environmentToSql: true };
    const service = new ReleaseDocsService(
      github as never,
      createReleaseService() as never,
      ai as never,
    );

    const result = await service.generate({
      repository: 'acme/project',
      releaseUnit: releaseUnit(),
      config: releaseConfig,
      input: {},
      runtime: { ai: { baseUrl: 'https://ai.example.com/v1', apiKey: 'secret', model: 'model' } },
      publish: { mode: 'apply', sideEffectGate: 'gate-' + 'x'.repeat(20) },
    });

    const envSection =
      result.markdown.split('## 各服务迁移环境变量\n')[1]?.split('\n## 更新内容(测试人员)')[0] ??
      '';
    const sqlSection = envSection.split('### env → sys_config\n')[1] ?? '';
    const sqlStatements = sqlSection
      .split(/\r?\n/)
      .filter((line) => line.startsWith('INSERT INTO'));
    expect(sqlSection).toContain(
      "VALUES ('APP_NAME', 'new', 'string', 'Application name Shown in the release UI')",
    );
    expect(sqlSection).toContain("VALUES ('NEW_PORT', '3000', 'number', '')");
    expect(sqlSection).toContain("VALUES ('API_TOKEN', 'latest-secret', 'string', '')");
    expect(sqlSection).toContain("VALUES ('PATH', 'C:\\\\release/v1', 'string', '')");
    expect(sqlStatements).toHaveLength(4);
    expect(sqlStatements.every((statement) => statement.includes('ON DUPLICATE KEY UPDATE'))).toBe(
      true,
    );
    expect(sqlSection).not.toContain('SAME');
    expect(sqlSection).not.toContain('REMOVED');
    expect(envSection).not.toContain('### 新增');
    expect(envSection).not.toContain('### 减少');
    expect(envSection).not.toContain('### 修改');
    expect(ai.request.mock.calls[0][0].prompt).not.toContain('latest-secret');
    expect(github.putContents).toHaveBeenCalledWith(
      expect.objectContaining({ content: result.markdown, mode: 'apply' }),
      releaseConfig,
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
