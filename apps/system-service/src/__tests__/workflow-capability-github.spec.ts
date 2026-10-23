import { describe, expect, it, vi } from 'vitest';
import { GithubCommitsClientService } from '../client/github/github-commits-client.service';
import { parseGithubRepository } from '../client/github/github-repository.util';
import type { ExternalHttpClientService } from '../client/external/external-http-client.service';
import type { GithubCommitsDto } from '../modules/workflow-capabilities/dto/github-commits.dto';
import { GithubCommitsCapabilityService } from '../modules/workflow-capabilities/github-commits-capability.service';
import { WorkflowCapabilityException } from '../modules/workflow-capabilities/workflow-capability.exception';

const TOKEN = 'ghp_SECRET_TOKEN_9f3a7c';

function rawCommit(index: number, options: { parents?: number; message?: string } = {}) {
  return {
    sha: `sha${index}`,
    parents: Array.from({ length: options.parents ?? 1 }, (_, i) => ({ sha: `p${i}` })),
    author: { login: `login${index}` },
    commit: {
      message: options.message ?? `feat: item ${index}\n\n正文 ${index}`,
      author: { name: `Author ${index}`, email: 'a@example.com', date: '2026-10-19T08:00:00Z' },
    },
  };
}

function page(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => rawCommit(start + i));
}

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function setup(responses: Array<ReturnType<typeof response>>) {
  const request = vi.fn();
  for (const item of responses) request.mockResolvedValueOnce(item);
  const client = new GithubCommitsClientService({
    request,
  } as unknown as ExternalHttpClientService);
  const service = new GithubCommitsCapabilityService(client);
  return { request, client, service };
}

function dto(overrides: Partial<GithubCommitsDto> = {}): GithubCommitsDto {
  return {
    repository: 'octo/repo',
    since: '2026-10-12T00:00:00+08:00',
    until: '2026-10-19T00:00:00+08:00',
    maxCommits: 500,
    runtime: { githubToken: TOKEN },
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

async function failure(promise: Promise<unknown>): Promise<WorkflowCapabilityException> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WorkflowCapabilityException);
  return error as WorkflowCapabilityException;
}

describe('parseGithubRepository', () => {
  it.each([
    ['octo/repo', { owner: 'octo', name: 'repo' }],
    ['https://github.com/octo/repo', { owner: 'octo', name: 'repo' }],
    ['https://github.com/octo/repo.git/', { owner: 'octo', name: 'repo' }],
    ['  https://GitHub.com/octo/my.repo-1 ', { owner: 'octo', name: 'my.repo-1' }],
  ])('accepts %s', (value, expected) => {
    expect(parseGithubRepository(value)).toEqual(expected);
  });

  it.each([
    'http://github.com/octo/repo',
    'https://evil.example.com/octo/repo',
    'https://token@github.com/octo/repo',
    'https://github.com/octo/repo?x=1',
    'https://github.com/octo/repo#frag',
    'https://github.com/octo',
    'https://github.com/octo/repo/tree/main',
    'git@github.com:octo/repo.git',
    'ssh://github.com/octo/repo',
    'octo',
    'octo/repo/extra',
    '../repo',
    'octo/..',
    '/repo',
  ])('rejects %s', (value) => {
    expect(() => parseGithubRepository(value)).toThrow(WorkflowCapabilityException);
  });
});

describe('GithubCommitsCapabilityService', () => {
  it('queries the fixed GitHub host with normalized filters and a bearer token', async () => {
    const { request, service } = setup([response(200, page(1, 2))]);

    const commits = await service.query(
      dto({ branch: ' release/1.0 ', author: ' alice ' }),
      signal(),
    );

    expect(commits.map((item) => item.hash)).toEqual(['sha1', 'sha2']);
    const call = request.mock.calls[0][0];
    expect(call.url.origin).toBe('https://api.github.com');
    expect(call.url.pathname).toBe('/repos/octo/repo/commits');
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      sha: 'release/1.0',
      author: 'alice',
      since: '2026-10-11T16:00:00.000Z',
      until: '2026-10-18T16:00:00.000Z',
      per_page: '100',
      page: '1',
    });
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url.href).not.toContain(TOKEN);
    expect(call.method).toBe('GET');
  });

  it('omits blank branch and author instead of sending empty filters', async () => {
    const { request, service } = setup([response(200, [])]);
    await expect(service.query(dto({ branch: '  ', author: '' }), signal())).resolves.toEqual([]);
    const params = request.mock.calls[0][0].url.searchParams;
    expect(params.has('sha')).toBe(false);
    expect(params.has('author')).toBe(false);
  });

  it('keeps merge commits and flags them without filtering anything', async () => {
    const { service } = setup([
      response(200, [
        rawCommit(1),
        rawCommit(2, { parents: 2, message: 'Merge pull request #1 from x/y' }),
        rawCommit(3, { parents: 1, message: 'Merge branch main into dev' }),
        rawCommit(4, { message: 'docs: english only' }),
      ]),
    ]);

    const commits = await service.query(dto(), signal());

    expect(commits.map((item) => [item.hash, item.isMerge])).toEqual([
      ['sha1', false],
      ['sha2', true],
      ['sha3', true],
      ['sha4', false],
    ]);
    expect(commits[0]).toEqual({
      hash: 'sha1',
      author: 'Author 1',
      date: '2026-10-19T08:00:00Z',
      subject: 'feat: item 1',
      body: '正文 1',
      isMerge: false,
    });
  });

  it('reads every page until a short page and preserves order', async () => {
    const { request, service } = setup([
      response(200, page(1, 100)),
      response(200, page(101, 100)),
      response(200, page(201, 30)),
    ]);

    const commits = await service.query(dto(), signal());

    expect(commits).toHaveLength(230);
    expect(commits[229].hash).toBe('sha230');
    expect(request.mock.calls.map((call) => call[0].url.searchParams.get('page'))).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('fails instead of silently truncating when commits exceed maxCommits', async () => {
    const { service } = setup([response(200, page(1, 100)), response(200, page(101, 60))]);
    const error = await failure(service.query(dto({ maxCommits: 150 }), signal()));
    expect(error.getStatus()).toBe(422);
    expect(error.message).toContain('maxCommits');

    // 恰好等于预算时成功；需要多取一页判断后面没有更多提交
    const exact = setup([
      response(200, page(1, 100)),
      response(200, page(101, 100)),
      response(200, []),
    ]);
    await expect(exact.service.query(dto({ maxCommits: 200 }), signal())).resolves.toHaveLength(
      200,
    );
  });

  it('fails when an exactly full last allowed page proves more commits exist', async () => {
    const { service, request } = setup([
      response(200, page(1, 100)),
      response(200, page(101, 100)),
    ]);
    const error = await failure(service.query(dto({ maxCommits: 100 }), signal()));
    expect(error.getStatus()).toBe(422);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails when aggregate commit content exceeds the byte budget', async () => {
    const big = (index: number) => rawCommit(index, { message: `s\n${'x'.repeat(400_000)}` });
    const { service } = setup([response(200, [big(1), big(2), big(3)])]);
    const error = await failure(service.query(dto(), signal()));
    expect(error.getStatus()).toBe(422);
  });

  it.each([
    [401, 'x', 502],
    [403, 'x', 502],
    [404, 'x', 404],
    [422, 'x', 422],
    [500, 'x', 502],
  ])('maps upstream HTTP %i without echoing the response body', async (status, _x, mapped) => {
    const { service } = setup([
      response(status, { message: `leak ${TOKEN}`, documentation_url: 'u' }),
    ]);
    const error = await failure(service.query(dto(), signal()));
    expect(error.getStatus()).toBe(mapped);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('leak');
  });

  it('maps rate limiting to 429', async () => {
    const limited = setup([response(403, {}, { 'x-ratelimit-remaining': '0' })]);
    expect((await failure(limited.service.query(dto(), signal()))).getStatus()).toBe(429);
    const throttled = setup([response(429, {})]);
    expect((await failure(throttled.service.query(dto(), signal()))).getStatus()).toBe(429);
  });

  it.each([
    ['not json', 'oops'],
    ['an object', { items: [] }],
    [
      'a commit without sha',
      [{ commit: { message: 'm', author: { date: '2026-10-19T08:00:00Z' } } }],
    ],
    [
      'a commit with an invalid date',
      [{ sha: 'a', commit: { message: 'm', author: { date: 'x' } } }],
    ],
  ])('treats %s as an invalid response rather than skipping items', async (_name, body) => {
    const { service } = setup([response(200, body)]);
    const error = await failure(service.query(dto(), signal()));
    expect(error.getStatus()).toBe(502);
  });

  it.each([
    ['since after until', { since: '2026-10-19T00:00:00Z', until: '2026-10-12T00:00:00Z' }],
    ['equal bounds', { since: '2026-10-19T00:00:00Z', until: '2026-10-19T00:00:00Z' }],
    ['more than 366 days', { since: '2025-01-01T00:00:00Z', until: '2026-10-19T00:00:00Z' }],
    [
      'an impossible calendar date',
      { since: '2026-02-31T00:00:00Z', until: '2026-10-19T00:00:00Z' },
    ],
  ])('rejects %s before any network request', async (_name, range) => {
    const { service, request } = setup([]);
    const error = await failure(service.query(dto(range), signal()));
    expect([400, 422]).toContain(error.getStatus());
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts exactly 366 days', async () => {
    const { service } = setup([response(200, [])]);
    await expect(
      service.query(
        dto({ since: '2025-10-19T00:00:00Z', until: '2026-10-20T00:00:00Z' }),
        signal(),
      ),
    ).resolves.toEqual([]);
  });

  it('rejects an invalid repository before any network request', async () => {
    const { service, request } = setup([]);
    await failure(service.query(dto({ repository: 'ssh://github.com/a/b' }), signal()));
    expect(request).not.toHaveBeenCalled();
  });

  it('passes a signal that follows the caller cancellation', async () => {
    const { service, request } = setup([response(200, [])]);
    const controller = new AbortController();
    await service.query(dto(), controller.signal);
    const passed: AbortSignal = request.mock.calls[0][0].signal;
    expect(passed.aborted).toBe(false);
    controller.abort();
    expect(passed.aborted).toBe(true);
  });
});
