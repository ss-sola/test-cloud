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
  requestTimeoutMs: 15_000,
  maxRetries: 2,
  monthlyTargets: [
    {
      month: '2026-08',
      wikiUrl: 'https://example.feishu.cn/wiki/wiki-token',
      sheetId: 'a0ab9d',
      lookupRange: 'A1:B200',
      name: '张三',
    },
  ],
};

describe('GenerateWeeklyCommitReportDto publish settings', () => {
  it('accepts a complete request-level Feishu configuration', async () => {
    const dto = plainToInstance(GenerateWeeklyCommitReportDto, {
      period: 'last-week',
      configs: [project],
      publish: { enabled: true, settings },
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

  it('rejects invalid request-level Feishu configuration values', async () => {
    const dto = plainToInstance(GenerateWeeklyCommitReportDto, {
      period: 'last-week',
      configs: [project],
      publish: {
        enabled: true,
        settings: {
          ...settings,
          appSecret: '',
          requestTimeoutMs: 999,
          maxRetries: 11,
          monthlyTargets: [
            { ...settings.monthlyTargets[0], month: '2026-13', lookupRange: 'C1:D2' },
          ],
        },
      },
    });

    await expect(validate(dto)).resolves.toSatisfy((errors) => errors.length > 0);
  });
});
