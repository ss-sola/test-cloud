import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { GenerateWeeklyCommitReportDto } from '../modules/weekly-commit-report/dto/generate-weekly-commit-report.dto';

const project = {
  repo: 'https://github.com/example/repository.git',
  person: 'person@example.com',
  branch: 'main',
};
const ai = { baseUrl: 'https://ai.example.com/v1', apiKey: 'ai-key', model: 'test-model' };

function build(runtime: Record<string, unknown>) {
  return plainToInstance(GenerateWeeklyCommitReportDto, {
    period: 'last-week',
    configs: [project],
    runtime: { githubToken: 'github-token', allowedRepositories: [project.repo], ...runtime },
  });
}

function collectPaths(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    return [...(error.constraints ? [path] : []), ...collectPaths(error.children ?? [], path)];
  });
}

describe('GenerateWeeklyCommitReportDto required AI configuration', () => {
  it('accepts a complete runtime.ai object', async () => {
    await expect(validate(build({ ai }))).resolves.toHaveLength(0);
  });

  it('rejects a request without runtime.ai', async () => {
    const errors = await validate(build({}));

    expect(collectPaths(errors)).toContain('runtime.ai');
  });

  it.each([null, 'ai', 1])('rejects a non-object runtime.ai: %j', async (value) => {
    const errors = await validate(build({ ai: value }));

    expect(errors.length).toBeGreaterThan(0);
  });

  it.each(['baseUrl', 'apiKey', 'model'] as const)(
    'rejects missing, empty, blank and non-string runtime.ai.%s',
    async (field) => {
      const { [field]: _omitted, ...withoutField } = ai;
      const invalidValues: Array<[string, Record<string, unknown>]> = [
        ['missing', withoutField],
        ['empty', { ...ai, [field]: '' }],
        ['spaces', { ...ai, [field]: '   ' }],
        ['tabs and newlines', { ...ai, [field]: ' \t\r\n ' }],
        ['number', { ...ai, [field]: 123 }],
        ['null', { ...ai, [field]: null }],
      ];

      for (const [label, value] of invalidValues) {
        const errors = await validate(build({ ai: value }));

        expect(collectPaths(errors), `${field} ${label}`).toContain(`runtime.ai.${field}`);
      }
    },
  );

  it.each([undefined, false, true])(
    'preserves enableThinking=%s with production-style implicit conversion',
    async (enableThinking) => {
      const prototype = Object.getPrototypeOf(build({ ai }).runtime.ai);
      Reflect.defineMetadata('design:type', Boolean, prototype, 'enableThinking');
      const pipe = new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        whitelist: true,
      });
      const dto = await pipe.transform(
        {
          period: 'this-week',
          configs: [project],
          runtime: { githubToken: 'github-token', ai: { ...ai, enableThinking } },
        },
        { type: 'body', metatype: GenerateWeeklyCommitReportDto },
      );
      expect(dto.runtime.ai.enableThinking).toBe(enableThinking);
    },
  );

  it.each([null, 'false', 'true', 0, 1, [], {}])(
    'rejects enableThinking=%j instead of coercing it',
    async (enableThinking) => {
      const prototype = Object.getPrototypeOf(build({ ai }).runtime.ai);
      Reflect.defineMetadata('design:type', Boolean, prototype, 'enableThinking');
      const pipe = new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        whitelist: true,
      });
      await expect(
        pipe.transform(
          {
            period: 'this-week',
            configs: [project],
            runtime: { githubToken: 'github-token', ai: { ...ai, enableThinking } },
          },
          { type: 'body', metatype: GenerateWeeklyCommitReportDto },
        ),
      ).rejects.toThrow('Bad Request Exception');
    },
  );

  it('reports every blank AI field in one validation pass', async () => {
    const errors = await validate(build({ ai: { baseUrl: ' ', apiKey: '', model: '\t' } }));

    expect(collectPaths(errors)).toEqual(
      expect.arrayContaining(['runtime.ai.baseUrl', 'runtime.ai.apiKey', 'runtime.ai.model']),
    );
  });

  it('keeps the existing AI field length limits', async () => {
    const errors = await validate(build({ ai: { ...ai, model: 'm'.repeat(257) } }));

    expect(collectPaths(errors)).toContain('runtime.ai.model');
  });
});
