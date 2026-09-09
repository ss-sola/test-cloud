import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ResponseUtil } from '@nest-cloud/common';
import { ConfigFilePreviewController } from '../modules/config-file-preview/config-file-preview.controller';
import { ConfigFilePreviewService } from '../modules/config-file-preview/config-file-preview.service';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConfigFilePreviewService', () => {
  it('uses the request GitHub token and reads the requested file directly', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({
        content: Buffer.from('APP_NAME=demo\n', 'utf8').toString('base64'),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConfigFilePreviewService();

    const result = await service.preview({
      repositoryUrl: 'https://github.com/example/project.git',
      branch: 'main',
      filePath: 'config/application.yml',
      tag: 'v1',
      githubToken: 'test-token',
    });

    expect(result.content).toBe('APP_NAME=demo\n');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/project/contents/config/application.yml?ref=v1',
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
        githubToken: 'test-token',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('ConfigFilePreviewController', () => {
  it('wraps preview results in the standard response envelope', async () => {
    const result = {
      repositoryUrl: 'https://github.com/example/project.git',
      branch: 'main',
      filePath: 'config/application.yml',
      selectedTag: 'v1',
      tags: [{ name: 'v1' }],
      content: 'x',
      byteLength: 1,
    };
    const service = { preview: vi.fn().mockResolvedValue(result) } as never;
    const controller = new ConfigFilePreviewController(service);
    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), { writableFinished: false });

    await expect(
      controller.preview(
        {
          repositoryUrl: result.repositoryUrl,
          branch: result.branch,
          filePath: result.filePath,
          tag: 'v1',
          githubToken: 'test-token',
        },
        request as never,
        response as never,
      ),
    ).resolves.toEqual(ResponseUtil.success(result));
  });
});
