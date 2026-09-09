import { Inject, Injectable, Optional } from '@nestjs/common';
import { ProjectException, RemoteClientBase, RemoteService } from '@nest-cloud/common';
import {
  RELEASE_AUTOMATION_DEFAULT_MAX_RESPONSE_BYTES,
  RELEASE_AUTOMATION_DEFAULT_MAX_RETRIES,
  RELEASE_AUTOMATION_DEFAULT_TIMEOUT_MS,
  RELEASE_AUTOMATION_SHA_PATTERN,
  RELEASE_AUTOMATION_TAG_PATTERN,
} from './release-automation.constants';
import { redactSensitiveText, sha256 } from './release-automation.security';
import type { ReleaseAutomationConfig } from './release-automation.config';
import type {
  GitHubCommitSummary,
  GitHubRef,
  GitHubRepository,
  ReleaseMode,
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

export interface GitHubCommitsOptions {
  repository: string;
  ref: string;
  page?: number;
  perPage?: number;
  maxPages?: number;
}

export interface GitHubCompareOptions {
  repository: string;
  base: string;
  head: string;
}

export interface GitHubBranchesOptions {
  repository: string;
  page?: number;
  perPage?: number;
  maxPages?: number;
}

export interface GitHubMergeOptions {
  repository: string;
  base: string;
  head: string;
  message: string;
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

export interface GitHubMergeResult {
  status: 'merged' | 'already-applied';
  sha?: string;
}

interface GitHubApiErrorOptions {
  status: number;
  retryable: boolean;
  operation: string;
}

export class GitHubApiException extends ProjectException {
  readonly retryable: boolean;
  readonly operation: string;

  constructor(message: string, options: GitHubApiErrorOptions) {
    super(message, options.status);
    this.retryable = options.retryable;
    this.operation = options.operation;
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
      `/repos/${repository.slug}/contents/${this.encodePath(path)}?ref=${encodeURIComponent(ref)}`,
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
    const sha = typeof payload.sha === 'string' ? payload.sha : '';
    if (!RELEASE_AUTOMATION_SHA_PATTERN.test(sha))
      throw this.invalidResponse('读取 GitHub Contents');
    return {
      content,
      sha,
      ref,
      repository: repository.slug,
      checksum: sha256(content),
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
      const payload = await this.request<unknown>(
        'GET',
        `/repos/${repository.slug}/commits?sha=${encodeURIComponent(ref)}&per_page=${perPage}&page=${page}`,
        '读取 GitHub 提交',
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
      `/repos/${repository.slug}/git/ref/${this.encodePath(normalizedRef)}`,
      '读取 GitHub ref',
      undefined,
      config,
    );
    if (!isRecord(payload) || typeof payload.ref !== 'string' || !isRecord(payload.object)) {
      throw this.invalidResponse('读取 GitHub ref');
    }
    const sha = typeof payload.object.sha === 'string' ? payload.object.sha : '';
    if (!RELEASE_AUTOMATION_SHA_PATTERN.test(sha)) throw this.invalidResponse('读取 GitHub ref');
    return {
      ref: payload.ref,
      sha,
      objectType: typeof payload.object.type === 'string' ? payload.object.type : undefined,
    };
  }

  async compare(options: GitHubCompareOptions): Promise<unknown> {
    const repository = this.assertRepository(options.repository);
    const base = this.assertRef(options.base);
    const head = this.assertRef(options.head);
    return this.request<unknown>(
      'GET',
      `/repos/${repository.slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      '比较 GitHub ref',
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
        `/repos/${repository.slug}/branches?per_page=${perPage}&page=${page}`,
        '读取 GitHub 分支',
      );
      if (!Array.isArray(payload)) throw this.invalidResponse('读取 GitHub 分支');
      for (const item of payload) {
        if (isRecord(item) && typeof item.name === 'string' && item.name.startsWith('custom/')) {
          branches.push(item.name);
        }
      }
      if (payload.length < perPage) break;
    }
    return [...new Set(branches)].sort((left, right) => left.localeCompare(right));
  }

  async merge(options: GitHubMergeOptions): Promise<GitHubMergeResult> {
    this.assertWriteGate(options.mode, options.sideEffectGate);
    const repository = this.assertRepository(options.repository);
    const base = this.assertBranch(options.base);
    const head = this.assertBranch(options.head);
    if (!options.message || options.message.length > 256 || hasControlCharacter(options.message)) {
      throw new ProjectException('GitHub 合并提交消息无效。', 400);
    }
    const response = await this.requestWithStatus(
      'POST',
      `/repos/${repository.slug}/merges`,
      '创建 GitHub 远程合并',
      { base, head, commit_message: options.message },
      [201, 204],
      false,
      options.config,
    );
    if (response.status === 204) return { status: 'already-applied' };
    const payload = parseJson(response.text);
    if (!isRecord(payload) || typeof payload.sha !== 'string') {
      throw this.invalidResponse('创建 GitHub 远程合并');
    }
    return { status: 'merged', sha: payload.sha };
  }

  async createTag(options: GitHubTagOptions): Promise<GitHubRef> {
    this.assertWriteGate(options.mode, options.sideEffectGate);
    const repository = this.assertRepository(options.repository);
    if (!RELEASE_AUTOMATION_TAG_PATTERN.test(options.tag)) {
      throw new ProjectException('GitHub tag 格式无效。', 400);
    }
    if (!RELEASE_AUTOMATION_SHA_PATTERN.test(options.sha)) {
      throw new ProjectException('GitHub tag 对象 SHA 格式无效。', 400);
    }
    const response = await this.requestWithStatus(
      'POST',
      `/repos/${repository.slug}/git/refs`,
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
    const objectSha = typeof payload.object.sha === 'string' ? payload.object.sha : '';
    if (!RELEASE_AUTOMATION_SHA_PATTERN.test(objectSha)) {
      throw this.invalidResponse('创建 GitHub tag');
    }
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
    method: 'GET' | 'POST',
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
    if (!slug) {
      throw new GitHubApiException('GitHub repository 格式无效。', {
        status: 400,
        retryable: false,
        operation: '校验 GitHub repository',
      });
    }
    const [owner, name] = slug.split('/');
    return { owner, name, slug };
  }

  private assertFilePath(value: string): string {
    if (
      !value ||
      value.startsWith('/') ||
      value.includes('..') ||
      value.includes('\\') ||
      hasControlCharacter(value)
    ) {
      throw new ProjectException('GitHub 文件路径无效。', 400);
    }
    return value;
  }

  private assertRef(value: string): string {
    if (
      !value ||
      value.length > 256 ||
      value.includes('..') ||
      value.includes('\\') ||
      hasControlCharacter(value)
    ) {
      throw new ProjectException('GitHub ref 无效。', 400);
    }
    return value;
  }

  private assertBranch(value: string): string {
    const ref = this.assertRef(value);
    if (!/^(?!-)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]+$/.test(ref))
      throw new ProjectException('GitHub 分支无效。', 400);
    return ref;
  }

  private assertWriteGate(mode: ReleaseMode, gate: string | undefined): void {
    if (mode !== 'apply' || !gate || gate.length < 16) {
      throw new ProjectException('GitHub 写操作需要独立 apply gate。', 403);
    }
  }

  private parseCommit(value: unknown): GitHubCommitSummary | null {
    if (
      !isRecord(value) ||
      typeof value.sha !== 'string' ||
      !RELEASE_AUTOMATION_SHA_PATTERN.test(value.sha) ||
      !isRecord(value.commit)
    ) {
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

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
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
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) return input.toLowerCase();
  return '';
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
