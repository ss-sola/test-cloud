import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ResponseUtil } from '@nest-cloud/common';
import { ConfigFilePreviewController } from '../modules/config-file-preview/config-file-preview.controller';
import { ConfigFilePreviewService } from '../modules/config-file-preview/config-file-preview.service';
import { CONFIG_FILE_PREVIEW_DEFAULTS } from '../modules/config-file-preview/config-file-preview.defaults';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_TAG_FILE_TOKEN;
});

describe('ConfigFilePreviewService', () => {
  it('returns TypeScript defaults without server-only fields', () => {
    const service = new ConfigFilePreviewService();
    expect(service.getDefaults()).toEqual(CONFIG_FILE_PREVIEW_DEFAULTS);
    expect(JSON.stringify(service.getDefaults())).not.toContain('password');
  });

  it('uses the system GitHub token and reads the requested file directly', async () => {
    process.env.GITHUB_TAG_FILE_TOKEN = 'test-token';
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({
        content: Buffer.from('APP_NAME=demo\n', 'utf8').toString('base64'),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConfigFilePreviewService();

    const result = await service.preview({
      repositoryUrl: 'https://github.com/whtthd/wzj-nodejs-v2.git',
      branch: 'dev/master',
      filePath: 'env/sample/sample.custom-wzj.env',
      tag: 'v1.8.0-2026-08-20',
    });

    expect(result.content).toBe('APP_NAME=demo\n');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/whtthd/wzj-nodejs-v2/contents/env/sample/sample.custom-wzj.env?ref=v1.8.0-2026-08-20',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-token',
          Accept: 'application/vnd.github+json',
        },
      }),
    );
  });

  it('forwards GitHub API errors without treating them as Git CLI errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('not found', 404));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConfigFilePreviewService();

    await expect(
      service.preview({
        repositoryUrl: 'https://github.com/example/project.git',
        branch: 'main',
        filePath: 'config/application.yml',
        tag: 'v1',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('ConfigFilePreviewController', () => {
  it('wraps defaults and preview results in the standard response envelope', async () => {
    const defaults = { ...CONFIG_FILE_PREVIEW_DEFAULTS };
    const result = {
      ...defaults,
      selectedTag: 'v1',
      tags: [{ name: 'v1' }],
      content: 'x',
      byteLength: 1,
    };
    const service = {
      getDefaults: vi.fn().mockReturnValue(defaults),
      preview: vi.fn().mockResolvedValue(result),
    } as never;
    const controller = new ConfigFilePreviewController(service);
    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), { writableFinished: false });

    expect(controller.getDefaults()).toEqual(ResponseUtil.success(defaults));
    await expect(
      controller.preview(
        {
          repositoryUrl: defaults.repositoryUrl,
          branch: defaults.branch,
          filePath: defaults.filePath,
        },
        request as never,
        response as never,
      ),
    ).resolves.toEqual(ResponseUtil.success(result));
  });
});
