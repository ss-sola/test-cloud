import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import axios from 'axios';
import { AI_MODEL_TRANSPORT } from '../../constants/ai-model.constants';
import { AiTextClientException } from './ai-text-client.exception';

interface OpenAiChatModelOptions {
  endpoint: URL;
  apiKey: string;
  model: string;
  enableThinking: boolean;
  temperature?: number;
  maxResponseBytes: number;
}

/** LangChain 官方模型适配接口，使用 Node HTTP 保留无主动截止和读取字节上限。 */
export class OpenAiCompatibleChatModel extends BaseChatModel {
  constructor(private readonly options: OpenAiChatModelOptions) {
    super({
      cache: false,
      disableStreaming: true,
      maxRetries: AI_MODEL_TRANSPORT.maxRetries,
      verbose: false,
      callbacks: [],
      outputVersion: 'v0',
    });
  }

  /** 标识本适配器使用的模型协议。 */
  _llmType(): string {
    return 'openai-compatible';
  }

  /** 将 LangChain 消息转换为一次非流式 Chat Completions 请求。 */
  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const response = await axios.request<string>({
      adapter: AI_MODEL_TRANSPORT.adapter,
      proxy: false,
      url: this.options.endpoint.toString(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
        'User-Agent': AI_MODEL_TRANSPORT.userAgent,
      },
      data: {
        model: this.options.model,
        stream: false,
        enable_thinking: this.options.enableThinking,
        ...(this.options.temperature !== undefined
          ? { temperature: this.options.temperature }
          : {}),
        messages: messages.map((message) => ({
          role: message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : 'system',
          content: message.content,
        })),
      },
      timeout: AI_MODEL_TRANSPORT.timeoutMs,
      maxRedirects: AI_MODEL_TRANSPORT.maxRedirects,
      maxContentLength: this.options.maxResponseBytes,
      signal: options.signal,
      responseType: 'text',
      transformResponse: [],
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new AiTextClientException(`AI 服务请求失败（HTTP ${response.status}）。`, 502);
    }
    if (
      typeof response.data !== 'string' ||
      Buffer.byteLength(response.data, 'utf8') > this.options.maxResponseBytes
    ) {
      throw new AiTextClientException('AI 响应超过长度预算。', 422);
    }
    let payload: { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> };
    try {
      payload = JSON.parse(response.data) as typeof payload;
    } catch {
      throw new AiTextClientException('AI 响应不是有效 JSON。', 502);
    }
    const choice = payload?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiTextClientException('AI 响应缺少文本内容。', 502);
    }
    const finishReason = choice?.finish_reason;
    if (finishReason !== 'stop') {
      throw new AiTextClientException(
        finishReason === 'length'
          ? 'AI 输出被上游截断，已拒绝不完整内容。'
          : 'AI 未明确完成输出（finish_reason 不是 stop），已拒绝残缺内容。',
        422,
      );
    }
    return {
      generations: [
        {
          text: content,
          message: new AIMessage({ content, response_metadata: { finish_reason: finishReason } }),
        },
      ],
    };
  }
}
