import { Injectable } from '@nestjs/common';
import {
  WORKFLOW_CAPABILITY_HOSTS,
  WORKFLOW_CAPABILITY_LIMITS,
} from '../../constants/workflow-capability.constants';
import { WorkflowCapabilityException } from '../../modules/workflow-capabilities/workflow-capability.exception';
import { ExternalHttpClientService } from '../external/external-http-client.service';
import type { ExternalHttpResponse } from '../external/external-http-client.service';
import type { GithubRepository } from './github-repository.util';

export interface GithubCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  isMerge: boolean;
}

export interface GithubCommitQuery {
  repository: GithubRepository;
  branch?: string;
  author?: string;
  since: string;
  until: string;
  maxCommits: number;
  token: string;
  signal: AbortSignal;
}

const MERGE_SUBJECT_PATTERN = /^Merge (?:pull request|branch|remote-tracking branch|tag)\b/;

/**
 * 查询单个 GitHub 仓库的提交，使用 api.github.com 域名直接发送 HTTPS 请求；
 * 原样保留 merge 提交并标记 isMerge，条数或聚合体积超出预算时明确失败，不静默截断。
 */
@Injectable()
export class GithubCommitsClientService {
  constructor(private readonly transport: ExternalHttpClientService) {}

  /** 分页读取区间内的提交；超过 maxCommits 或聚合体积预算时抛出异常。 */
  async listCommits(query: GithubCommitQuery): Promise<GithubCommit[]> {
    const pageSize = WORKFLOW_CAPABILITY_LIMITS.githubPageSize;
    // 多取一条用来判断实际数量是否超过 maxCommits
    const maxPages = Math.ceil((query.maxCommits + 1) / pageSize);
    const commits: GithubCommit[] = [];
    let aggregateBytes = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.transport.request({
        url: this.buildUrl(query, page),
        method: 'GET',
        headers: {
          Authorization: `Bearer ${query.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'nestcloud-workflow',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeoutMs: WORKFLOW_CAPABILITY_LIMITS.githubRequestTimeoutMs,
        maxResponseBytes: WORKFLOW_CAPABILITY_LIMITS.maxUpstreamResponseBytes,
        signal: query.signal,
      });
      this.assertSuccess(response);

      const items = this.parsePage(response.body);
      for (const item of items) {
        const commit = this.mapCommit(item);
        aggregateBytes += Buffer.byteLength(JSON.stringify(commit), 'utf8');
        commits.push(commit);
      }
      if (commits.length > query.maxCommits) {
        throw new WorkflowCapabilityException(
          '提交数量超过 maxCommits 预算，请缩小时间范围或提高上限。',
          422,
        );
      }
      if (aggregateBytes > WORKFLOW_CAPABILITY_LIMITS.githubMaxAggregateBytes) {
        throw new WorkflowCapabilityException('提交内容总量超过预算，请缩小时间范围。', 422);
      }
      if (items.length < pageSize) break;
    }
    return commits;
  }

  private buildUrl(query: GithubCommitQuery, page: number): URL {
    const { owner, name } = query.repository;
    const url = new URL(
      `https://${WORKFLOW_CAPABILITY_HOSTS.github}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits`,
    );
    if (query.branch) url.searchParams.set('sha', query.branch);
    if (query.author) url.searchParams.set('author', query.author);
    url.searchParams.set('since', query.since);
    url.searchParams.set('until', query.until);
    url.searchParams.set('per_page', String(WORKFLOW_CAPABILITY_LIMITS.githubPageSize));
    url.searchParams.set('page', String(page));
    return url;
  }

  /** 将上游 HTTP 状态转换为固定文案，不携带上游响应正文。 */
  private assertSuccess(response: ExternalHttpResponse): void {
    if (response.status >= 200 && response.status < 300) return;
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers['x-ratelimit-remaining'] === '0' || !!response.headers['retry-after']));
    if (rateLimited)
      throw new WorkflowCapabilityException('GitHub 请求频率受限，请稍后重试。', 429);
    if (response.status === 404) {
      throw new WorkflowCapabilityException('GitHub 仓库或分支不存在，或令牌无权访问。', 404);
    }
    if (response.status === 401 || response.status === 403) {
      throw new WorkflowCapabilityException('GitHub 拒绝了令牌，请检查 githubToken 配置。', 502);
    }
    if (response.status === 422) {
      throw new WorkflowCapabilityException('GitHub 无法处理提交查询参数。', 422);
    }
    throw new WorkflowCapabilityException(`GitHub 请求失败（HTTP ${response.status}）。`, 502);
  }

  private parsePage(body: string): unknown[] {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new WorkflowCapabilityException('GitHub 提交响应格式无效。', 502);
    }
    if (!Array.isArray(payload)) {
      throw new WorkflowCapabilityException('GitHub 提交响应格式无效。', 502);
    }
    return payload;
  }

  /** 将 GitHub 提交映射为稳定结构；字段缺失视为响应无效而不是静默跳过。 */
  private mapCommit(value: unknown): GithubCommit {
    const record = (value ?? {}) as {
      sha?: unknown;
      parents?: unknown;
      author?: { login?: unknown } | null;
      commit?: {
        message?: unknown;
        author?: { name?: unknown; email?: unknown; date?: unknown };
        committer?: { date?: unknown };
      };
    };
    const message = record.commit?.message;
    const dateValue = record.commit?.author?.date ?? record.commit?.committer?.date;
    if (
      typeof record.sha !== 'string' ||
      !record.sha ||
      typeof message !== 'string' ||
      typeof dateValue !== 'string' ||
      Number.isNaN(Date.parse(dateValue))
    ) {
      throw new WorkflowCapabilityException('GitHub 提交响应格式无效。', 502);
    }

    const lines = message.split(/\r?\n/);
    const subject = (lines.shift() ?? '').trim();
    const authorName = [
      record.commit?.author?.name,
      record.author?.login,
      record.commit?.author?.email,
    ].find((item): item is string => typeof item === 'string' && item.length > 0);
    return {
      hash: record.sha,
      author: authorName ?? '',
      date: dateValue,
      subject,
      body: lines.join('\n').trim(),
      isMerge:
        (Array.isArray(record.parents) && record.parents.length > 1) ||
        MERGE_SUBJECT_PATTERN.test(subject),
    };
  }
}
