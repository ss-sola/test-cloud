export const CONTENT_COMPARE_LIMITS = Object.freeze({
  maxTextLength: 500_000,
  maxDepth: 64,
  maxNodes: 10_000,
  maxPathLength: 4_096,
  maxErrors: 100,
  maxBodyBytes: 6 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
});

export const CONTENT_COMPARE_API_PATH = '/api/content-compare';
