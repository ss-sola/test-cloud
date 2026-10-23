/** 模型客户端的技术预算；业务模块可在本次调用中提供更严格的限制。 */
export const AI_MODEL_LIMITS = Object.freeze({
  maxPromptCharacters: 200_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxOutputCharacters: 500_000,
});

export const AI_MODEL_DEFAULTS = Object.freeze({
  enableThinking: false,
});

export const AI_MODEL_TRANSPORT = Object.freeze({
  adapter: 'http' as const,
  timeoutMs: 0,
  maxRedirects: 0,
  maxRetries: 0,
  userAgent: 'nestcloud-ai-client',
});
