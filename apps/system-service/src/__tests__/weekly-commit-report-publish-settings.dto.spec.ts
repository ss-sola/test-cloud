import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { GenerateWeeklyCommitReportDto } from '../modules/weekly-commit-report/dto/generate-weekly-commit-report.dto';

const project = {
  repo: 'https://github.com/example/repository.git',
  person: 'person@example.com',
  branch: 'main',
};

const settings = {
  appId: 'cli_app_id',
  appSecret: 'secret',
  wikiUrl: 'https://example.feishu.cn/wiki/wiki-token?sheet=a0ab9d',
  name: '张三',
};

describe('GenerateWeeklyCommitReportDto publish settings', () => {
  it('accepts a flat request-level Feishu configuration', async () => {
    const dto = plainToInstance(GenerateWeeklyCommitReportDto, {
      period: 'last-week',
      configs: [project],
      publish: { enabled: true, settings },
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('allows credentials and name to be omitted for server fallback and inference', async () => {
    const dto = plainToInstance(GenerateWeeklyCommitReportDto, {
      period: 'last-week',
      configs: [project],
      publish: {
        enabled: true,
        settings: { wikiUrl: settings.wikiUrl },
      },
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('allows explicitly disabled publication without settings', async () => {
    const dto = plainToInstance(GenerateWeeklyCommitReportDto, {
      period: 'last-week',
      configs: [project],
      publish: { enabled: false },
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects missing or invalid Wiki address values', async () => {
    const missing = plainToInstance(GenerateWeeklyCommitReportDto, {
      period: 'last-week',
      configs: [project],
      publish: { enabled: true, settings: { name: '张三' } },
    });
    const invalid = plainToInstance(GenerateWeeklyCommitReportDto, {
      period: 'last-week',
      configs: [project],
      publish: {
        enabled: true,
        settings: { ...settings, wikiUrl: 'x'.repeat(2049) },
      },
    });

    await expect(validate(missing)).resolves.toSatisfy((errors) => errors.length > 0);
    await expect(validate(invalid)).resolves.toSatisfy((errors) => errors.length > 0);
  });

  it('rejects the removed monthly target shape without a Wiki address', async () => {
    const dto = plainToInstance(GenerateWeeklyCommitReportDto, {
      period: 'last-week',
      configs: [project],
      publish: {
        enabled: true,
        settings: {
          appId: settings.appId,
          appSecret: settings.appSecret,
          monthlyTargets: [{ month: '2026-08', wikiUrl: settings.wikiUrl }],
        },
      },
    });

    await expect(validate(dto)).resolves.toSatisfy((errors) => errors.length > 0);
  });
});
