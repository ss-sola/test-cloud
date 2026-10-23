import { Injectable } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import axios from 'axios';
import { traceable } from 'langsmith/traceable';
import { AI_MODEL_DEFAULTS, AI_MODEL_LIMITS } from '../../constants/ai-model.constants';
import { AiTextClientException } from './ai-text-client.exception';
import { OpenAiCompatibleChatModel } from './openai-compatible-chat-model';

export interface AiTextRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  enableThinking?: boolean;
  prompt: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  temperature?: number;
  maxPromptCharacters?: number;
  maxResponseBytes?: number;
  maxOutputCharacters?: number;
}

/** 唯一模型客户端：每次请求经 LangChain invoke 调用，不保存模型、凭据或生成状态。 */
@Injectable()
export class AiTextClientService {
  /** 生成完整文本；只有显式提供 timeoutMs 时才建立本次调用的截止信号。 */
  async generate(request: AiTextRequest): Promise<string> {
    request.signal?.throwIfAborted();
    if (!request.baseUrl.trim() || !request.apiKey.trim() || !request.model.trim()) {
      throw new AiTextClientException('AI 配置不完整，需要 baseUrl、apiKey 和 model。', 400);
    }
    if (!request.prompt.trim()) throw new AiTextClientException('prompt 不能为空。', 400);
    if (
      request.prompt.length > (request.maxPromptCharacters ?? AI_MODEL_LIMITS.maxPromptCharacters)
    ) {
      throw new AiTextClientException('AI prompt 超过长度限制。', 422);
    }
    let endpoint: URL;
    try {
      endpoint = new URL(request.baseUrl);
    } catch {
      throw new AiTextClientException('AI baseUrl 无效。', 400);
    }
    if (!['http:', 'https:'].includes(endpoint.protocol))
      throw new AiTextClientException('AI baseUrl 必须使用 HTTP(S) 协议。', 400);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), request.timeoutMs);
    const signal = request.signal
      ? request.timeoutMs === undefined
        ? request.signal
        : AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    try {
      const model = new OpenAiCompatibleChatModel({
        endpoint,
        apiKey: request.apiKey,
        model: request.model,
        enableThinking: request.enableThinking ?? AI_MODEL_DEFAULTS.enableThinking,
        temperature: request.temperature,
        maxResponseBytes: request.maxResponseBytes ?? AI_MODEL_LIMITS.maxResponseBytes,
      });
      const messages = [
        ...(request.systemPrompt?.trim() ? [new SystemMessage(request.systemPrompt)] : []),
        new HumanMessage(request.prompt),
      ];
      const invoke = traceable(
        async () => model.invoke(messages, { signal, callbacks: [], maxRetries: 0 }),
        { name: 'nestcloud-model-call', tracingEnabled: false },
      );
      const result = await invoke();
      signal.throwIfAborted();
      const text = result.content;
      if (typeof text !== 'string' || !text.trim())
        throw new AiTextClientException('AI 响应缺少文本内容。', 502);
      if (text.length > (request.maxOutputCharacters ?? AI_MODEL_LIMITS.maxOutputCharacters)) {
        throw new AiTextClientException('AI 输出超过长度预算。', 422);
      }
      return text;
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (controller.signal.aborted) {
        throw new AiTextClientException(`AI 请求超时（${request.timeoutMs}ms）。`, 504);
      }
      if (error instanceof AiTextClientException) throw error;
      if (
        axios.isAxiosError(error) &&
        error.code === 'ERR_BAD_RESPONSE' &&
        error.message.includes('maxContentLength')
      ) {
        throw new AiTextClientException('AI 响应超过长度预算。', 422);
      }
      throw new AiTextClientException('AI 请求异常，请检查网络、baseUrl 和服务端可用性。', 502);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
