import { Injectable, Logger } from '@nestjs/common';
import {
  WORKDAY_CALENDAR_DATE_PATTERN,
  WORKDAY_CALENDAR_DAY_MS,
  WORKDAY_CALENDAR_LIMITS,
  WORKDAY_CALENDAR_MESSAGES,
  WORKDAY_CALENDAR_NAME_PATTERN,
  WORKDAY_CALENDAR_PAPER_URL_PATTERN,
  WORKDAY_CALENDAR_SOURCE_BASE_URL,
  WORKDAY_CALENDAR_SOURCE_FILE_SUFFIX,
} from '../../constants/workday-calendar.constants';
import { WorkflowCapabilityException } from '../../modules/workflow-capabilities/workflow-capability.exception';
import type {
  WorkdayCalendarOverride,
  WorkdayCalendarYear,
} from '../../modules/workflow-capabilities/workday-calendar.types';
import { ExternalHttpClientService } from '../external/external-http-client.service';

/** 解析 YYYY-MM-DD 民用日期并校验真实存在，返回自 1970-01-01 起的 UTC 日序号；无效返回 null。 */
export function parseCivilDay(value: unknown): number | null {
  if (typeof value !== 'string' || !WORKDAY_CALENDAR_DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;
  return date.getTime() / WORKDAY_CALENDAR_DAY_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 读取并校验单个年度的节假日安排：固定 HTTPS 主机与路径，无凭据、无重试、无缓存。
 * 年度文件只提供放假/补班覆盖项；结构校验无法证明第三方数据没有漏录合法覆盖项。
 */
@Injectable()
export class WorkdayCalendarClientService {
  private readonly logger = new Logger(WorkdayCalendarClientService.name);

  constructor(private readonly transport: ExternalHttpClientService) {}

  /** 拉取 {year}.json 并按白名单规范化；未发布抛 503，数据结构错误抛 502，超时/取消沿用 504/499。 */
  async loadYear(year: number, signal: AbortSignal): Promise<WorkdayCalendarYear> {
    const limits = WORKDAY_CALENDAR_LIMITS;
    if (!Number.isInteger(year) || year < limits.minYear || year > limits.maxYear) {
      throw new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.yearUnsupported, 422);
    }
    const url = new URL(
      `${WORKDAY_CALENDAR_SOURCE_BASE_URL}${year}${WORKDAY_CALENDAR_SOURCE_FILE_SUFFIX}`,
    );
    this.assertActive(signal); // 请求前

    let response;
    try {
      response = await this.transport.request({
        url,
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'nestcloud-workflow' },
        timeoutMs: limits.requestTimeoutMs,
        maxResponseBytes: limits.maxResponseBytes,
        signal,
      });
    } catch (error) {
      if (error instanceof WorkflowCapabilityException) throw error;
      this.assertActive(signal);
      throw new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.unreachable, 502);
    }
    this.assertActive(signal); // 响应后

    if (response.status === 404) {
      throw new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.notPublished, 503);
    }
    if (response.status !== 200) {
      throw new WorkflowCapabilityException(`日历数据源请求失败（HTTP ${response.status}）。`, 502);
    }
    return this.parseYear(response.body, year, url.href);
  }

  /** 严格校验年度文件并只保留白名单字段；原文与校验细节不进入异常消息。 */
  private parseYear(body: string, year: number, url: string): WorkdayCalendarYear {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw this.invalid(year, 'JSON 无法解析');
    }
    if (!isRecord(payload)) throw this.invalid(year, '根节点不是对象');
    if (payload.year !== year) throw this.invalid(year, '年度与请求不一致');

    const limits = WORKDAY_CALENDAR_LIMITS;
    const rawPapers = payload.papers;
    if (!Array.isArray(rawPapers) || rawPapers.length < 1 || rawPapers.length > limits.maxPapers) {
      throw this.invalid(year, 'papers 数量无效');
    }
    const papers = rawPapers.map((paper: unknown) => {
      if (
        typeof paper !== 'string' ||
        paper.length > limits.maxPaperUrlLength ||
        !WORKDAY_CALENDAR_PAPER_URL_PATTERN.test(paper)
      ) {
        throw this.invalid(year, 'papers 链接不受信任');
      }
      return paper;
    });

    const rawDays = payload.days;
    if (
      !Array.isArray(rawDays) ||
      rawDays.length < 1 ||
      rawDays.length > limits.maxOverridesPerYear
    ) {
      throw this.invalid(year, 'days 数量无效');
    }
    const seen = new Set<string>();
    const days = rawDays.map((item: unknown) => {
      const override = this.parseOverride(item, year);
      if (seen.has(override.date)) throw this.invalid(year, 'days 日期重复');
      seen.add(override.date);
      return override;
    });
    days.sort((left, right) => (left.date < right.date ? -1 : 1));
    return { year, url, papers, days };
  }

  /** 校验单条放假或补班覆盖，不接受无关年度与重复日期之外的隐式修补。 */
  private parseOverride(item: unknown, year: number): WorkdayCalendarOverride {
    if (!isRecord(item)) throw this.invalid(year, 'days 条目不是对象');
    const { date, name, isOffDay } = item;
    if (parseCivilDay(date) === null) throw this.invalid(year, 'days 日期无效');
    if (
      Math.abs(Number((date as string).slice(0, 4)) - year) > WORKDAY_CALENDAR_LIMITS.maxYearOffset
    ) {
      throw this.invalid(year, 'days 日期超出相邻年度范围');
    }
    if (
      typeof name !== 'string' ||
      name.length > WORKDAY_CALENDAR_LIMITS.maxNameLength ||
      !WORKDAY_CALENDAR_NAME_PATTERN.test(name)
    ) {
      throw this.invalid(year, 'days 名称无效');
    }
    if (typeof isOffDay !== 'boolean') throw this.invalid(year, 'isOffDay 不是布尔值');
    return { date: date as string, name, isOffDay };
  }

  /** 校验失败只在后端记录固定原因，对外统一为数据结构错误（502）。 */
  private invalid(year: number, reason: string): WorkflowCapabilityException {
    this.logger.warn(`${year} 年日历数据校验失败：${reason}`);
    return new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.invalidData, 502);
  }

  /** 超时与调用方取消沿用外部请求的 504/499 语义。 */
  private assertActive(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const reason: unknown = signal.reason;
    throw reason instanceof Error && reason.name === 'TimeoutError'
      ? new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.timeout, 504)
      : new WorkflowCapabilityException(WORKDAY_CALENDAR_MESSAGES.cancelled, 499);
  }
}
