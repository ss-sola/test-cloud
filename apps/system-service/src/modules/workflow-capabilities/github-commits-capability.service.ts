import { Injectable } from '@nestjs/common';
import { GithubCommitsClientService } from '../../client/github/github-commits-client.service';
import type { GithubCommit } from '../../client/github/github-commits-client.service';
import { parseGithubRepository } from '../../client/github/github-repository.util';
import { WORKFLOW_CAPABILITY_LIMITS } from '../../constants/workflow-capability.constants';
import type { GithubCommitsDto } from './dto/github-commits.dto';
import { WorkflowCapabilityException } from './workflow-capability.exception';

const DAY_MS = 24 * 60 * 60 * 1000;

/** GitHub 提交查询能力：只校验输入并读取原始提交，不做周报过滤、去重或摘要。 */
@Injectable()
export class GithubCommitsCapabilityService {
  constructor(private readonly client: GithubCommitsClientService) {}

  /** 校验仓库与时间范围预算后查询提交；超过预算由客户端明确失败。 */
  async query(input: GithubCommitsDto, signal: AbortSignal): Promise<GithubCommit[]> {
    const repository = parseGithubRepository(input.repository);
    const since = this.parseInstant(input.since);
    const until = this.parseInstant(input.until);
    if (since >= until) {
      throw new WorkflowCapabilityException('since 必须早于 until。', 400);
    }
    if (until - since > WORKFLOW_CAPABILITY_LIMITS.githubMaxRangeDays * DAY_MS) {
      throw new WorkflowCapabilityException(
        `时间跨度不能超过 ${WORKFLOW_CAPABILITY_LIMITS.githubMaxRangeDays} 天。`,
        422,
      );
    }

    return this.client.listCommits({
      repository,
      branch: input.branch?.trim() || undefined,
      author: input.author?.trim() || undefined,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      maxCommits: input.maxCommits,
      token: input.runtime.githubToken,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(WORKFLOW_CAPABILITY_LIMITS.githubTotalTimeoutMs),
      ]),
    });
  }

  /** 解析带时区的 ISO 时间并校验真实日历日期，避免 02-31 被引擎顺延为 03-03。 */
  private parseInstant(value: string): number {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
    const timestamp = Date.parse(value);
    if (!parts || Number.isNaN(timestamp)) {
      throw new WorkflowCapabilityException('since/until 必须是有效的 ISO 时间。', 400);
    }
    const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      throw new WorkflowCapabilityException('since/until 必须是有效的 ISO 时间。', 400);
    }
    return timestamp;
  }
}
