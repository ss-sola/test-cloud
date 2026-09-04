import { Inject, Injectable, Optional } from '@nestjs/common';
import { ProjectException, RemoteClientBase, RemoteService } from '@nest-cloud/common';
import {
  RELEASE_AUTOMATION_DEFAULT_MAX_RETRIES,
  RELEASE_AUTOMATION_DEFAULT_MAX_RESPONSE_BYTES,
  RELEASE_AUTOMATION_DEFAULT_TIMEOUT_MS,
  RELEASE_AUTOMATION_QUEUE_ID_PATTERN,
  RELEASE_AUTOMATION_SHA_PATTERN,
  RELEASE_AUTOMATION_TAG_PATTERN,
  RELEASE_AUTOMATION_VERSION,
} from './release-automation.constants';
import { isJenkinsReady, readReleaseAutomationConfig } from './release-automation.config';
import { resolveSecret, redactSensitiveText } from './release-automation.security';
import type { ReleaseAutomationConfig } from './release-automation.config';
import type { JenkinsPackageResult, JenkinsReleaseOptions } from './release-automation.types';
import type { ReleaseSecretProvider } from './release-automation.security';
import type { GitHubFetch } from './github-release-client.service';

export const JENKINS_CLIENT_OPTIONS = Symbol('JENKINS_CLIENT_OPTIONS');

export interface JenkinsClientOptions {
  config?: ReleaseAutomationConfig;
  fetchImpl?: GitHubFetch;
  secretProvider?: ReleaseSecretProvider;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export class JenkinsApiException extends ProjectException {
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message, status);
    this.retryable = retryable;
  }
}

interface JenkinsResponse {
  status: number;
  text: string;
  headers: Headers;
}

@RemoteService({ url: 'http://127.0.0.1' })
@Injectable()
export class JenkinsClientService extends RemoteClientBase {
  private readonly options?: JenkinsClientOptions;

  constructor(@Optional() @Inject(JENKINS_CLIENT_OPTIONS) options?: JenkinsClientOptions) {
    super();
    this.options = options;
  }

  async package(options: JenkinsReleaseOptions): Promise<JenkinsPackageResult> {
    const config = this.getConfig();
    const readiness = this.checkReadiness(config);
    if (readiness) return { status: 'blocked', reason: readiness };
    if (options.releaseUnit.version !== RELEASE_AUTOMATION_VERSION) {
      throw new ProjectException(`Jenkins 版本必须固定为 ${RELEASE_AUTOMATION_VERSION}。`, 400);
    }
    if (
      !RELEASE_AUTOMATION_SHA_PATTERN.test(options.releaseUnit.candidateSha) ||
      !/^custom\/[A-Za-z0-9._/-]+$/.test(options.releaseUnit.targetBranch) ||
      !/^[0-9a-f]{64}$/i.test(options.planHash)
    ) {
      throw new ProjectException('Jenkins release unit 或 planHash 无效。', 400);
    }
    if (options.mode !== 'apply' || !options.sideEffectGate || options.sideEffectGate.length < 16) {
      return { status: 'planned', reason: 'dry-run 或缺少独立 Jenkins apply gate。' };
    }

    const queueId = await this.trigger(options);
    let buildNumber: number;
    try {
      buildNumber = await this.waitForQueue(queueId, config);
    } catch (error) {
      if (error instanceof JenkinsApiException && error.message.includes('触发')) {
        return { status: 'manual-intervention', queueId, reason: error.message };
      }
      throw error;
    }
    const build = await this.waitForBuild(queueId, buildNumber, config);
    if (build.result !== 'SUCCESS') {
      return {
        status: 'failed',
        queueId,
        buildNumber,
        reason: `Jenkins 构建结果为 ${build.result ?? '未知'}。`,
      };
    }
    const buildSha = extractBuildSha(build.payload);
    if (!buildSha) {
      return {
        status: 'manual-intervention',
        queueId,
        buildNumber,
        reason: 'Jenkins 构建响应缺少可验证的来源 SHA。',
      };
    }
    if (buildSha.toLowerCase() !== options.releaseUnit.candidateSha.toLowerCase()) {
      return {
        status: 'manual-intervention',
        queueId,
        buildNumber,
        reason: 'Jenkins 构建来源 SHA 与 candidateSha 不一致。',
      };
    }
    const pipeline = await this.readPipeline(buildNumber, config);
    const pipelineTag = parsePipelineTag(pipeline);
    return {
      status: 'verified',
      queueId,
      buildNumber,
      pipelineTag,
      candidateSha: options.releaseUnit.candidateSha,
    };
  }

  async reconcile(input: { queueId: string; buildNumber?: number }): Promise<JenkinsPackageResult> {
    const config = this.getConfig();
    const queueId = assertNumericId(input.queueId, 'queue');
    if (input.buildNumber === undefined) {
      const buildNumber = await this.waitForQueue(queueId, config);
      return {
        status: 'planned',
        queueId,
        buildNumber,
        reason: '已解析 queue 与 build 绑定，可继续 reconcile。',
      };
    }
    const buildNumber = Number(assertNumericId(String(input.buildNumber), 'build'));
    const build = await this.requestBuild(queueId, buildNumber, config);
    return {
      status: build.result === 'SUCCESS' ? 'planned' : 'failed',
      queueId,
      buildNumber,
      reason: build.result ?? '构建仍在进行。',
    };
  }

  private async trigger(options: JenkinsReleaseOptions): Promise<string> {
    const config = this.getConfig();
    const query = new URLSearchParams({
      candidateSha: options.releaseUnit.candidateSha,
      version: RELEASE_AUTOMATION_VERSION,
      planHash: options.planHash,
      buildMode: 'package',
      dryRun: 'false',
      skipTest: '0',
    });
    if (config.jenkinsPlatform) query.set('platform', config.jenkinsPlatform);
    const response = await this.request(
      'POST',
      `${config.jenkinsTriggerPath}?${query.toString()}`,
      '触发 Jenkins Pipeline',
      false,
      undefined,
      [201],
    );
    if (response.text.trim())
      throw new JenkinsApiException('Jenkins 触发响应体必须为空。', 502, false);
    const location = response.headers.get('location');
    if (!location) throw new JenkinsApiException('Jenkins 触发响应缺少 Location。', 502, false);
    return parseQueueId(location, config.jenkinsBaseUrl!);
  }

  private async waitForQueue(queueId: string, config: ReleaseAutomationConfig): Promise<number> {
    const validQueueId = assertNumericId(queueId, 'queue');
    const deadline = this.getNow() + config.jenkinsQueueTimeoutMs;
    for (;;) {
      if (this.getNow() > deadline)
        throw new JenkinsApiException('Jenkins 队列轮询超时。', 504, false);
      const path = this.fillPath(config.jenkinsQueuePathTemplate!, 'queueId', validQueueId);
      const payload = await this.requestJson(path, '查询 Jenkins 队列', config);
      if (!isRecord(payload))
        throw new JenkinsApiException('Jenkins 队列响应结构无效。', 502, false);
      if (payload.cancelled === true)
        throw new JenkinsApiException('Jenkins 队列项已取消。', 409, false);
      if (payload.stuck === true)
        throw new JenkinsApiException('Jenkins 队列项已卡住。', 409, false);
      if (
        isRecord(payload.executable) &&
        typeof payload.executable.number === 'number' &&
        Number.isInteger(payload.executable.number) &&
        payload.executable.number > 0
      )
        return payload.executable.number;
      await this.delay(config.jenkinsPollIntervalMs);
    }
  }

  private async waitForBuild(
    queueId: string,
    buildNumber: number,
    config: ReleaseAutomationConfig,
  ): Promise<{ result: string | null; payload: unknown }> {
    const validBuildNumber = assertNumericId(String(buildNumber), 'build');
    const deadline = this.getNow() + config.jenkinsBuildTimeoutMs;
    for (;;) {
      if (this.getNow() > deadline)
        throw new JenkinsApiException('Jenkins 构建轮询超时。', 504, false);
      const build = await this.requestBuild(queueId, Number(validBuildNumber), config);
      const building =
        build.payload &&
        isRecord(build.payload) &&
        (build.payload.building === true || build.payload.inProgress === true);
      if (build.result === 'SUCCESS' && !building) return build;
      if (!building && build.result && build.result !== 'SUCCESS') return build;
      await this.delay(config.jenkinsPollIntervalMs);
    }
  }

  private async requestBuild(
    queueId: string,
    buildNumber: number,
    config: ReleaseAutomationConfig,
  ): Promise<{ result: string | null; payload: unknown }> {
    const path = this.fillPath(
      config.jenkinsBuildPathTemplate!,
      'buildNumber',
      String(buildNumber),
    );
    const payload = await this.requestJson(path, '查询 Jenkins 构建', config);
    if (!isRecord(payload)) throw new JenkinsApiException('Jenkins 构建响应结构无效。', 502, false);
    if (payload.queueId !== undefined && String(payload.queueId) !== queueId)
      throw new JenkinsApiException('Jenkins 构建 queueId 不匹配。', 409, false);
    if (
      typeof payload.number !== 'number' ||
      !Number.isInteger(payload.number) ||
      payload.number !== buildNumber
    ) {
      throw new JenkinsApiException('Jenkins 构建 number 与 queue executable 不匹配。', 409, false);
    }
    const result =
      payload.result === null || payload.result === undefined
        ? null
        : typeof payload.result === 'string' && payload.result
          ? payload.result
          : (() => {
              throw new JenkinsApiException('Jenkins 构建 result 响应无效。', 502, false);
            })();
    return { result, payload };
  }

  private async readPipeline(
    buildNumber: number,
    config: ReleaseAutomationConfig,
  ): Promise<string> {
    const path = this.fillPath(
      config.jenkinsPipelineTextPathTemplate!,
      'buildNumber',
      String(buildNumber),
    );
    const response = await this.request(
      'GET',
      path,
      '读取完整 Jenkins Pipeline',
      true,
      config,
      [200],
      true,
    );
    if (!response.text)
      throw new JenkinsApiException('完整 Jenkins Pipeline 响应为空。', 502, false);
    return response.text;
  }

  private async requestJson(
    path: string,
    operation: string,
    config: ReleaseAutomationConfig,
  ): Promise<unknown> {
    const response = await this.request('GET', path, operation, true, config, [200]);
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      throw new JenkinsApiException(`Jenkins ${operation}返回了无法解析的 JSON。`, 502, false);
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    operation: string,
    retryableRequest: boolean,
    passedConfig?: ReleaseAutomationConfig,
    expectedStatuses: number[] = [200],
    textResponse = false,
  ): Promise<JenkinsResponse> {
    const config = passedConfig ?? this.getConfig();
    const url = this.buildUrl(config, path);
    const secret = await resolveSecret(config.jenkinsCredentialRef, this.options?.secretProvider);
    if (!secret) throw new JenkinsApiException('Jenkins 凭据缺失或无法解析。', 403, false);
    const fetchImpl = this.options?.fetchImpl ?? (globalThis.fetch.bind(globalThis) as GitHubFetch);
    const maxRetries = retryableRequest
      ? (config.jenkinsMaxRetries ?? RELEASE_AUTOMATION_DEFAULT_MAX_RETRIES)
      : 0;
    const timeoutMs = config.jenkinsTimeoutMs ?? RELEASE_AUTOMATION_DEFAULT_TIMEOUT_MS;
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method,
          headers: {
            Accept: textResponse ? 'text/plain' : 'application/json',
            Authorization: secret,
          },
          body: undefined,
          signal: controller.signal,
          redirect: 'error',
        });
        const text = await response.text();
        const maxResponseBytes =
          config.jenkinsMaxResponseBytes ??
          config.githubMaxResponseBytes ??
          RELEASE_AUTOMATION_DEFAULT_MAX_RESPONSE_BYTES;
        if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
          throw new JenkinsApiException('Jenkins 响应超过大小限制。', 502, false);
        }
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          await this.delay(this.retryDelay(response.headers, attempt));
          continue;
        }
        if (!expectedStatuses.includes(response.status))
          throw new JenkinsApiException(
            `Jenkins ${operation}失败（HTTP ${response.status}${this.errorDetail(text)}）。`,
            response.status,
            response.status === 429 || response.status >= 500,
          );
        return { status: response.status, text, headers: response.headers };
      } catch (error) {
        if (error instanceof JenkinsApiException) throw error;
        if (attempt >= maxRetries) {
          const timeoutError =
            (error instanceof DOMException && error.name === 'AbortError') ||
            (error instanceof Error && error.name === 'AbortError');
          throw new JenkinsApiException(
            `Jenkins ${operation}${timeoutError ? '超时' : '请求异常'}。`,
            timeoutError ? 504 : 502,
            false,
          );
        }
        await this.delay(this.retryDelay(undefined, attempt));
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private checkReadiness(config: ReleaseAutomationConfig): string | undefined {
    if (!config.jenkinsBaseUrl) return 'Jenkins 地址待配置。';
    if (!config.jenkinsCredentialRef) return 'Jenkins 凭据待配置。';
    if (!isJenkinsReady(config))
      return 'Jenkins trigger/queue/build 或完整 Pipeline endpoint 待配置。';
    if (!this.options?.secretProvider) return 'Jenkins secret provider 待配置。';
    return undefined;
  }

  private buildUrl(config: ReleaseAutomationConfig, path: string): string {
    const url = new URL(path, `${config.jenkinsBaseUrl}/`);
    const base = new URL(config.jenkinsBaseUrl!);
    if (
      url.origin !== base.origin ||
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      url.search.toLowerCase().includes('secret')
    )
      throw new JenkinsApiException('Jenkins URL 不在同 origin 或不安全。', 500, false);
    return url.toString();
  }

  private fillPath(template: string, key: 'queueId' | 'buildNumber', value: string): string {
    if (!template.includes(`{${key}}`))
      throw new JenkinsApiException('Jenkins 路径模板缺少动态编号。', 500, false);
    const result = template.replaceAll(`{${key}}`, value);
    if (/\{[A-Za-z][A-Za-z0-9]*\}/.test(result))
      throw new JenkinsApiException('Jenkins 路径模板存在未替换参数。', 500, false);
    return result;
  }

  private retryDelay(headers: Headers | undefined, attempt: number): number {
    const seconds = Number(headers?.get('retry-after'));
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds * 1000, 5000)
      : Math.min(250 * 2 ** attempt, 5000);
  }

  private delay(milliseconds: number): Promise<void> {
    return (
      this.options?.sleep ??
      ((value: number) => new Promise<void>((resolve) => setTimeout(resolve, value)))
    )(milliseconds);
  }

  private getNow(): number {
    return this.options?.now?.() ?? Date.now();
  }

  private getConfig(): ReleaseAutomationConfig {
    return this.options?.config ?? readReleaseAutomationConfig();
  }

  private errorDetail(text: string): string {
    return text ? `：${redactSensitiveText(text)}` : '';
  }
}

export function parseQueueId(location: string, baseUrl: string): string {
  try {
    const locationUrl = new URL(location, `${baseUrl}/`);
    const base = new URL(baseUrl);
    if (locationUrl.origin !== base.origin || locationUrl.search || locationUrl.hash)
      throw new Error('origin');
    const match = locationUrl.pathname.match(/^\/queue\/item\/(\d+)\/?$/);
    if (!match || !RELEASE_AUTOMATION_QUEUE_ID_PATTERN.test(match[1])) throw new Error('path');
    return match[1];
  } catch {
    throw new JenkinsApiException('Jenkins Location 无法解析为同 origin 的 queue id。', 502, false);
  }
}

export function parsePipelineTag(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.at(-1)?.trim() !== 'Finished: SUCCESS')
    throw new JenkinsApiException(
      '完整 Jenkins Pipeline 未以 Finished: SUCCESS 结束。',
      502,
      false,
    );
  const marker = 'backend-wzj-nodejs-v2:';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const markerIndex = lines[index].indexOf(marker);
    if (markerIndex < 0) continue;
    const tag = lines[index].slice(markerIndex + marker.length).trim();
    if (
      !tag ||
      /[ -\s]/.test(tag) ||
      !RELEASE_AUTOMATION_TAG_PATTERN.test(tag) ||
      !tag.startsWith(`${RELEASE_AUTOMATION_VERSION}`)
    )
      throw new JenkinsApiException('Pipeline 输出 tag 无效。', 502, false);
    return tag;
  }
  throw new JenkinsApiException('Pipeline 输出中找不到受控 tag。', 502, false);
}

function assertNumericId(value: string, label: string): string {
  if (!RELEASE_AUTOMATION_QUEUE_ID_PATTERN.test(value) || Number(value) <= 0)
    throw new ProjectException(`Jenkins ${label} id 无效。`, 400);
  return value;
}

function extractBuildSha(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.actions)) return undefined;
  for (const action of payload.actions) {
    if (!isRecord(action) || !isRecord(action.lastBuiltRevision)) continue;
    const sha = action.lastBuiltRevision.SHA1;
    if (typeof sha === 'string' && RELEASE_AUTOMATION_SHA_PATTERN.test(sha)) return sha;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
