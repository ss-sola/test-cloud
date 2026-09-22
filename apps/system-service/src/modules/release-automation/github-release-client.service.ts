import { Inject, Injectable, Optional } from '@nestjs/common';
import { ProjectException, RemoteClientBase, RemoteService } from '@nest-cloud/common';
import {
  RELEASE_AUTOMATION_DEFAULT_MAX_RESPONSE_BYTES,
  RELEASE_AUTOMATION_DEFAULT_MAX_RETRIES,
  RELEASE_AUTOMATION_DEFAULT_TIMEOUT_MS,
} from './release-automation.constants';
import { redactSensitiveText, sha256 } from './release-automation.security';
import type { ReleaseAutomationConfig } from './release-automation.config';
import type {
  GitHubCommitSummary,
  GitHubRef,
  GitHubRepository,
  ReleaseMode,
  ReleasePullRequest,
} from './release-automation.types';

export const GITHUB_RELEASE_CLIENT_OPTIONS = Symbol('GITHUB_RELEASE_CLIENT_OPTIONS');

export interface GitHubFetchResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type GitHubFetch = (input: string | URL, init?: RequestInit) => Promise<GitHubFetchResponse>;

export interface GitHubReleaseClientOptions {
  config?: ReleaseAutomationConfig;
  fetchImpl?: GitHubFetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface GitHubContentsOptions {
  repository: string;
  path: string;
  ref: string;
}

export interface GitHubContentsResult {
  content: string;
  sha: string;
  ref: string;
  repository: string;
  checksum: string;
}

export interface GitHubContentsWriteOptions {
  repository: string;
  path: string;
  branch: string;
  content: string;
  commitMessage: string;
  mode: ReleaseMode;
  sideEffectGate?: string;
}

export interface GitHubContentsWriteResult {
  status: 'created' | 'updated' | 'unchanged';
  path: string;
  branch: string;
  commitSha?: string;
  blobSha?: string;
  checksum: string;
}

export interface GitHubCommitsOptions {
  repository: string;
  ref: string;
  since?: string;
  until?: string;
  path?: string;
  config?: ReleaseAutomationConfig;
  page?: number;
  perPage?: number;
  maxPages?: number;
}

export interface GitHubTagSummary {
  name: string;
  sha: string;
}

export interface GitHubTagsOptions {
  repository: string;
  config?: ReleaseAutomationConfig;
  page?: number;
  perPage?: number;
  maxPages?: number;
}

export interface GitHubCompareOptions {
  repository: string;
  base: string;
  head: string;
  config?: ReleaseAutomationConfig;
}

export interface GitHubBranchesOptions {
  repository: string;
  page?: number;
  perPage?: number;
  maxPages?: number;
}

export interface GitHubPullRequestsOptions {
  repository: string;
  base: string;
  head: string;
  config?: ReleaseAutomationConfig;
}

export interface GitHubCreatePullRequestOptions {
  repository: string;
  base: string;
  head: string;
  title: string;
  body?: string;
  mode: ReleaseMode;
  sideEffectGate?: string;
  config?: ReleaseAutomationConfig;
}

export interface GitHubTagOptions {
  repository: string;
  tag: string;
  sha: string;
  mode: ReleaseMode;
  sideEffectGate?: string;
  config?: ReleaseAutomationConfig;
}

interface GitHubApiErrorOptions {
  status: number;
  retryable: boolean;
  operation: string;
  detail?: string;
}

export class GitHubApiException extends ProjectException {
  readonly retryable: boolean;
  readonly operation: string;
  readonly detail?: string;

  constructor(message: string, options: GitHubApiErrorOptions) {
    super(message, options.status);
    this.retryable = options.retryable;
    this.operation = options.operation;
    this.detail = options.detail;
  }
}

@RemoteService({ url: 'https://api.github.com' })
@Injectable()
export class GitHubReleaseClientService extends RemoteClientBase {
  private readonly options?: GitHubReleaseClientOptions;

  constructor(
    @Optional() @Inject(GITHUB_RELEASE_CLIENT_OPTIONS) options?: GitHubReleaseClientOptions,
  ) {
    super();
    this.options = options;
  }

  async getContents(
    options: GitHubContentsOptions,
    config?: ReleaseAutomationConfig,
  ): Promise<GitHubContentsResult> {
    const repository = this.assertRepository(options.repository);
    const path = this.assertFilePath(options.path);
    const ref = this.assertRef(options.ref);
    const payload = await this.request<unknown>(
      'GET',
      `/repos/${this.encodePath(repository.slug)}/contents/${this.encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      '读取 GitHub Contents',
      undefined,
      config,
    );
    if (!isRecord(payload) || payload.type !== 'file' || typeof payload.content !== 'string') {
      throw this.invalidResponse('读取 GitHub Contents');
    }
    const encoding = typeof payload.encoding === 'string' ? payload.encoding : 'base64';
    if (encoding !== 'base64') throw this.invalidResponse('读取 GitHub Contents');
    const content = Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (typeof payload.sha !== 'string') throw this.invalidResponse('读取 GitHub Contents');
    const sha = payload.sha;
    return {
      content,
      sha,
      ref,
      repository: repository.slug,
      checksum: sha256(content),
    };
  }

  async putContents(
    options: GitHubContentsWriteOptions,
    config?: ReleaseAutomationConfig,
  ): Promise<GitHubContentsWriteResult> {
    this.assertWriteGate(options.mode, options.sideEffectGate);
    const repository = this.assertRepository(options.repository);
    const path = this.assertFilePath(options.path);
    const branch = this.assertRef(options.branch);
    if (
      !options.commitMessage ||
      options.commitMessage.length > 256 ||
      hasControlCharacter(options.commitMessage)
    ) {
      throw new ProjectException('GitHub 文件提交消息无效。', 400);
    }

    let existing: GitHubContentsResult | undefined;
    try {
      existing = await this.getContents({ repository: repository.slug, path, ref: branch }, config);
    } catch (error) {
      if (!(error instanceof GitHubApiException) || error.getStatus() !== 404) throw error;
    }
    const checksum = sha256(options.content);
    if (existing?.checksum === checksum) {
      return {
        status: 'unchanged',
        path,
        branch,
        blobSha: existing.sha,
        checksum,
      };
    }

    const payload = await this.requestWithStatus(
      'PUT',
      `/repos/${this.encodePath(repository.slug)}/contents/${this.encodePath(path)}`,
      '写入 GitHub Contents',
      {
        message: options.commitMessage,
        content: Buffer.from(options.content, 'utf8').toString('base64'),
        branch,
        ...(existing ? { sha: existing.sha } : {}),
      },
      [200, 201],
      false,
      config,
    );
    const value = parseJson(payload.text);
    if (
      !isRecord(value) ||
      !isRecord(value.content) ||
      typeof value.content.sha !== 'string' ||
      !isRecord(value.commit) ||
      typeof value.commit.sha !== 'string'
    ) {
      throw this.invalidResponse('写入 GitHub Contents');
    }
    return {
      status: existing ? 'updated' : 'created',
      path,
      branch,
      blobSha: value.content.sha,
      commitSha: value.commit.sha,
      checksum,
    };
  }

  async listCommits(options: GitHubCommitsOptions): Promise<GitHubCommitSummary[]> {
    const repository = this.assertRepository(options.repository);
    const ref = this.assertRef(options.ref);
    const perPage = this.boundInteger(options.perPage ?? 100, 1, 100);
    const maxPages = this.boundInteger(options.maxPages ?? 10, 1, 100);
    const firstPage = this.boundInteger(options.page ?? 1, 1, 10_000);
    const commits: GitHubCommitSummary[] = [];
    for (let page = firstPage; page < firstPage + maxPages; page += 1) {
      const query = new URLSearchParams({
        sha: ref,
        per_page: String(perPage),
        page: String(page),
      });
      if (options.since) query.set('since', options.since);
      if (options.until) query.set('until', options.until);
      if (options.path) query.set('path', options.path);
      const payload = await this.request<unknown>(
        'GET',
        `/repos/${this.encodePath(repository.slug)}/commits?${query.toString()}`,
        '读取 GitHub 提交',
        undefined,
        options.config,
      );
      if (!Array.isArray(payload)) throw this.invalidResponse('读取 GitHub 提交');
      for (const item of payload) {
        const parsed = this.parseCommit(item);
        if (parsed) commits.push(parsed);
      }
      if (payload.length < perPage) break;
    }
    return commits;
  }

  async getRef(
    repositoryInput: string,
    refInput: string,
    config?: ReleaseAutomationConfig,
  ): Promise<GitHubRef> {
    const repository = this.assertRepository(repositoryInput);
    const ref = this.assertRef(refInput);
    const normalizedRef = ref.startsWith('refs/') ? ref.slice(5) : ref;
    const payload = await this.request<unknown>(
      'GET',
      `/repos/${this.encodePath(repository.slug)}/git/ref/${this.encodePath(normalizedRef)}`,
      '读取 GitHub ref',
      undefined,
      config,
    );
    if (!isRecord(payload) || typeof payload.ref !== 'string' || !isRecord(payload.object)) {
      throw this.invalidResponse('读取 GitHub ref');
    }
    if (typeof payload.object.sha !== 'string') throw this.invalidResponse('读取 GitHub ref');
    const sha = payload.object.sha;
    return {
      ref: payload.ref,
      sha,
      objectType: typeof payload.object.type === 'string' ? payload.object.type : undefined,
    };
  }

  async listTags(options: GitHubTagsOptions): Promise<GitHubTagSummary[]> {
    const repository = this.assertRepository(options.repository);
    const perPage = this.boundInteger(options.perPage ?? 100, 1, 100);
    const maxPages = this.boundInteger(options.maxPages ?? 10, 1, 100);
    const firstPage = this.boundInteger(options.page ?? 1, 1, 10_000);
    const tags: GitHubTagSummary[] = [];
    for (let page = firstPage; page < firstPage + maxPages; page += 1) {
      const query = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
      });
      const payload = await this.request<unknown>(
        'GET',
        `/repos/${this.encodePath(repository.slug)}/tags?${query.toString()}`,
        '读取 GitHub tags',
        undefined,
        options.config,
      );
      if (!Array.isArray(payload)) throw this.invalidResponse('读取 GitHub tags');
      for (const item of payload) {
        if (
          isRecord(item) &&
          typeof item.name === 'string' &&
          isRecord(item.commit) &&
          typeof item.commit.sha === 'string'
        ) {
          tags.push({ name: item.name, sha: item.commit.sha });
        }
      }
      if (payload.length < perPage) break;
    }
    return tags;
  }

  async compareCommits(options: GitHubCompareOptions): Promise<GitHubCommitSummary[]> {
    const payload = await this.compare(options);
    if (!isRecord(payload) || !Array.isArray(payload.commits)) {
      throw this.invalidResponse('比较 GitHub commits');
    }
    return payload.commits
      .map((item) => this.parseCommit(item))
      .filter((item): item is GitHubCommitSummary => item !== null);
  }

  async compare(options: GitHubCompareOptions): Promise<unknown> {
    const repository = this.assertRepository(options.repository);
    const base = this.assertRef(options.base);
    const head = this.assertRef(options.head);
    return this.request<unknown>(
      'GET',
      `/repos/${this.encodePath(repository.slug)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      '比较 GitHub ref',
      undefined,
      options.config,
    );
  }

  async listBranches(options: GitHubBranchesOptions): Promise<string[]> {
    const repository = this.assertRepository(options.repository);
    const perPage = this.boundInteger(options.perPage ?? 100, 1, 100);
    const maxPages = this.boundInteger(options.maxPages ?? 10, 1, 100);
    const firstPage = this.boundInteger(options.page ?? 1, 1, 10_000);
    const branches: string[] = [];
    for (let page = firstPage; page < firstPage + maxPages; page += 1) {
      const payload = await this.request<unknown>(
        'GET',
        `/repos/${this.encodePath(repository.slug)}/branches?per_page=${perPage}&page=${page}`,
        '读取 GitHub 分支',
      );
      if (!Array.isArray(payload)) throw this.invalidResponse('读取 GitHub 分支');
      for (const item of payload) {
        if (isRecord(item) && typeof item.name === 'string') branches.push(item.name);
      }
      if (payload.length < perPage) break;
    }
    return [...new Set(branches)].sort((left, right) => left.localeCompare(right));
  }

  async listPullRequests(options: GitHubPullRequestsOptions): Promise<ReleasePullRequest[]> {
    const repository = this.assertRepository(options.repository);
    const base = this.assertRef(options.base);
    const head = this.assertRef(options.head);
    const query = new URLSearchParams({
      state: 'open',
      head: `${repository.owner}:${head}`,
      base,
      per_page: '100',
    });
    const payload = await this.request<unknown>(
      'GET',
      `/repos/${this.encodePath(repository.slug)}/pulls?${query.toString()}`,
      '查询 GitHub Pull Request',
      undefined,
      options.config,
    );
    if (!Array.isArray(payload)) throw this.invalidResponse('查询 GitHub Pull Request');
    const pullRequests: ReleasePullRequest[] = [];
    for (const item of payload) {
      const pullRequest = this.parsePullRequest(item);
      if (!pullRequest) throw this.invalidResponse('查询 GitHub Pull Request');
      pullRequests.push(pullRequest);
    }
    return pullRequests;
  }

  async createPullRequest(options: GitHubCreatePullRequestOptions): Promise<ReleasePullRequest> {
    this.assertWriteGate(options.mode, options.sideEffectGate);
    const repository = this.assertRepository(options.repository);
    const base = this.assertRef(options.base);
    const head = this.assertRef(options.head);
    if (!options.title || options.title.length > 256 || hasControlCharacter(options.title)) {
      throw new ProjectException('GitHub Pull Request 标题无效。', 400);
    }
    if (options.body && (options.body.length > 65_536 || hasControlCharacter(options.body, true))) {
      throw new ProjectException('GitHub Pull Request 内容无效。', 400);
    }
    const response = await this.requestWithStatus(
      'POST',
      `/repos/${this.encodePath(repository.slug)}/pulls`,
      '创建 GitHub Pull Request',
      {
        title: options.title,
        head,
        base,
        ...(options.body ? { body: options.body } : {}),
      },
      [201],
      false,
      options.config,
    );
    const payload = parseJson(response.text);
    const pullRequest = this.parsePullRequest(payload);
    if (!pullRequest) throw this.invalidResponse('创建 GitHub Pull Request');
    return pullRequest;
  }

  async createTag(options: GitHubTagOptions): Promise<GitHubRef> {
    this.assertWriteGate(options.mode, options.sideEffectGate);
    const repository = this.assertRepository(options.repository);
    const response = await this.requestWithStatus(
      'POST',
      `/repos/${this.encodePath(repository.slug)}/git/refs`,
      '创建 GitHub tag',
      { ref: `refs/tags/${options.tag}`, sha: options.sha },
      [201],
      false,
      options.config,
    );
    const payload = parseJson(response.text);
    if (!isRecord(payload) || typeof payload.ref !== 'string' || !isRecord(payload.object)) {
      throw this.invalidResponse('创建 GitHub tag');
    }
    if (typeof payload.object.sha !== 'string') throw this.invalidResponse('创建 GitHub tag');
    const objectSha = payload.object.sha;
    return {
      ref: payload.ref,
      sha: objectSha,
      objectType: typeof payload.object.type === 'string' ? payload.object.type : undefined,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    operation: string,
    body?: unknown,
    config?: ReleaseAutomationConfig,
  ): Promise<T> {
    const response = await this.requestWithStatus(
      method,
      path,
      operation,
      body,
      [200],
      true,
      config,
    );
    if (!response.text.trim()) throw this.invalidResponse(operation);
    const payload = parseJson(response.text);
    return payload as T;
  }

  private async requestWithStatus(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    operation: string,
    body: unknown,
    expectedStatuses: number[],
    retryable = method === 'GET',
    config?: ReleaseAutomationConfig,
  ): Promise<{ status: number; text: string; headers: Headers }> {
    const resolvedConfig = this.getConfig(config);
    const url = this.buildUrl(resolvedConfig, path);
    const token = resolvedConfig.githubToken;
    const fetchImpl = this.getFetch();
    const maxRetries = retryable
      ? (resolvedConfig.githubMaxRetries ?? RELEASE_AUTOMATION_DEFAULT_MAX_RETRIES)
      : 0;
    const timeoutMs = resolvedConfig.githubTimeoutMs ?? RELEASE_AUTOMATION_DEFAULT_TIMEOUT_MS;
    const maxBytes =
      resolvedConfig.githubMaxResponseBytes ?? RELEASE_AUTOMATION_DEFAULT_MAX_RESPONSE_BYTES;

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'NestCloud-release-automation',
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        });
        const text = await this.readResponseText(response, maxBytes);
        if (response.status === 429 || response.status >= 500) {
          if (attempt < maxRetries) {
            await this.delay(this.retryDelay(response.headers, attempt));
            continue;
          }
        }
        if (!expectedStatuses.includes(response.status)) {
          throw new GitHubApiException(
            `GitHub ${operation}失败（HTTP ${response.status}${this.safeErrorDetail(text)}）。`,
            {
              status: response.status,
              retryable: response.status === 429 || response.status >= 500,
              operation,
              detail: redactSensitiveText(text).slice(0, 2_000),
            },
          );
        }
        return { status: response.status, text, headers: response.headers };
      } catch (error) {
        if (error instanceof GitHubApiException) throw error;
        if (attempt >= maxRetries) {
          const timedOut = error instanceof DOMException && error.name === 'AbortError';
          throw new GitHubApiException(`GitHub ${operation}${timedOut ? '超时' : '请求异常'}。`, {
            status: timedOut ? 504 : 502,
            retryable: false,
            operation,
          });
        }
        await this.delay(this.retryDelay(undefined, attempt));
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private async readResponseText(response: GitHubFetchResponse, maxBytes: number): Promise<string> {
    if (response.arrayBuffer) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes)
        throw new GitHubApiException('GitHub 响应超过大小限制。', {
          status: 502,
          retryable: false,
          operation: '读取 GitHub 响应',
        });
      return buffer.toString('utf8');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes)
      throw new GitHubApiException('GitHub 响应超过大小限制。', {
        status: 502,
        retryable: false,
        operation: '读取 GitHub 响应',
      });
    return text;
  }

  private buildUrl(config: ReleaseAutomationConfig, path: string): string {
    const base = new URL(config.githubBaseUrl);
    const url = new URL(path, `${config.githubBaseUrl}/`);
    if (
      url.origin !== base.origin ||
      !config.githubAllowedHosts.includes(url.hostname.toLowerCase())
    ) {
      throw new GitHubApiException('GitHub API host 不在 allowlist。', {
        status: 500,
        retryable: false,
        operation: '构造 GitHub URL',
      });
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search.includes('token')) {
      throw new GitHubApiException('GitHub API URL 不安全。', {
        status: 500,
        retryable: false,
        operation: '构造 GitHub URL',
      });
    }
    return url.toString();
  }

  private assertRepository(value: string): GitHubRepository {
    const slug = normalizeRepository(value);
    const [owner = '', ...nameParts] = slug.split('/');
    return { owner, name: nameParts.join('/'), slug };
  }

  private assertFilePath(value: string): string {
    return value;
  }

  private assertRef(value: string): string {
    return value;
  }

  private assertWriteGate(mode: ReleaseMode, gate: string | undefined): void {
    if (mode !== 'apply' || !gate || gate.length < 16) {
      throw new ProjectException('GitHub 写操作需要独立 apply gate。', 403);
    }
  }

  private parseCommit(value: unknown): GitHubCommitSummary | null {
    if (!isRecord(value) || typeof value.sha !== 'string' || !isRecord(value.commit)) {
      return null;
    }
    const message =
      typeof value.commit.message === 'string' ? value.commit.message.slice(0, 8_000) : '';
    const author = value.commit.author as unknown;
    const authorRecord: Record<string, unknown> | undefined =
      author && typeof author === 'object' && !Array.isArray(author)
        ? (author as Record<string, unknown>)
        : undefined;
    return {
      sha: value.sha,
      message,
      author: typeof authorRecord?.name === 'string' ? authorRecord.name.slice(0, 256) : null,
      date: typeof authorRecord?.date === 'string' ? authorRecord.date : null,
      isMerge: Array.isArray(value.parents) && value.parents.length > 1,
    };
  }

  private parsePullRequest(value: unknown): ReleasePullRequest | null {
    if (!isRecord(value)) return null;
    const base = isRecord(value.base) ? value.base : undefined;
    const head = isRecord(value.head) ? value.head : undefined;
    const state = value.state === 'open' || value.state === 'closed' ? value.state : undefined;
    const mergeable =
      value.mergeable === null || typeof value.mergeable === 'boolean'
        ? value.mergeable
        : undefined;
    const mergeableState =
      value.mergeable_state === 'behind' ||
      value.mergeable_state === 'blocked' ||
      value.mergeable_state === 'clean' ||
      value.mergeable_state === 'dirty' ||
      value.mergeable_state === 'draft' ||
      value.mergeable_state === 'has_hooks' ||
      value.mergeable_state === 'unknown' ||
      value.mergeable_state === 'unstable' ||
      value.mergeable_state === 'unreachable'
        ? value.mergeable_state
        : undefined;
    if (
      typeof value.number !== 'number' ||
      !Number.isInteger(value.number) ||
      value.number <= 0 ||
      typeof value.html_url !== 'string' ||
      !value.html_url ||
      typeof value.title !== 'string' ||
      !state ||
      !base ||
      typeof base.ref !== 'string' ||
      !head ||
      typeof head.ref !== 'string' ||
      typeof head.sha !== 'string'
    ) {
      return null;
    }
    return {
      number: value.number,
      url: value.html_url,
      title: value.title,
      state,
      baseBranch: base.ref,
      headBranch: head.ref,
      headSha: head.sha,
      mergeable,
      mergeableState,
    };
  }

  private invalidResponse(operation: string): GitHubApiException {
    return new GitHubApiException(`GitHub ${operation}返回结构无效。`, {
      status: 502,
      retryable: false,
      operation,
    });
  }

  private safeErrorDetail(text: string): string {
    if (!text) return '';
    return `：${redactSensitiveText(text)}`;
  }

  private retryDelay(headers: Headers | undefined, attempt: number): number {
    const retryAfter = headers?.get('retry-after');
    const seconds = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
    return Math.min(250 * 2 ** attempt, 5_000);
  }

  private delay(milliseconds: number): Promise<void> {
    return (
      this.options?.sleep ??
      ((value: number) => new Promise<void>((resolve) => setTimeout(resolve, value)))
    )(milliseconds);
  }

  private getFetch(): GitHubFetch {
    return this.options?.fetchImpl ?? (globalThis.fetch.bind(globalThis) as GitHubFetch);
  }

  private getConfig(config?: ReleaseAutomationConfig): ReleaseAutomationConfig {
    const resolved = config ?? this.options?.config;
    if (!resolved) throw new ProjectException('GitHub 调用缺少请求级运行配置。', 500);
    return resolved;
  }

  private boundInteger(value: number, min: number, max: number): number {
    return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : min;
  }

  private encodePath(path: string): string {
    return path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }
}

function hasControlCharacter(value: string, allowLineBreaks = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (allowLineBreaks && (code === 0x0a || code === 0x0d)) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeRepository(value: string): string {
  const input = value
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  if (/^https:\/\/github\.com\//i.test(input))
    return input.replace(/^https:\/\/github\.com\//i, '').toLowerCase();
  return input.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new GitHubApiException('GitHub 返回了无法解析的响应。', {
      status: 502,
      retryable: false,
      operation: '解析 GitHub 响应',
    });
  }
}
