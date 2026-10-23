import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// public/workflow/*.json 是可由用户随时替换的样例流程，不纳入测试；只校验随文档交付的 OpenAPI 文件。
describe('workflow capability exported OpenAPI file', () => {
  it('keeps the local OpenAPI context contract optional for old direct callers with explicit integer budgets', () => {
    const api = JSON.parse(
      readFileSync(resolve(__dirname, '../../docs/workflow-capabilities/openapi.json'), 'utf8'),
    );
    const input = api.components.schemas.AiTextInput;
    expect(input.required).toEqual(['prompt', 'runtime']);
    expect(input.additionalProperties).toBe(false);
    expect(input.properties.contextWindowTokens).toMatchObject({
      type: 'integer',
      minimum: 4096,
      maximum: 1000000,
      default: 100000,
    });
    expect(input.properties.maxTokens.deprecated).toBe(true);
    expect(api.paths['/api/workflow-capabilities/ai-text'].post.responses).toHaveProperty('422');
  });
});
