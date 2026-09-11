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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it.each(['', '   '])('resolves the first available tag when tag is %j', async (tag) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response([{ name: '', commit: { sha: 'ignored' } }, { name: 'v2' }, { name: 'v1' }]),
      )
      .mockResolvedValueOnce(
        response({ content: Buffer.from('APP_NAME=latest\n', 'utf8').toString('base64') }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConfigFilePreviewService();
    const signal = new AbortController().signal;

    const result = await service.preview(
      {
        repositoryUrl: 'https://github.com/example/project.git',
        branch: 'main',
        filePath: 'config/application.yml',
        tag,
        githubToken: 'test-token',
      },
      signal,
    );

    expect(result.selectedTag).toBe('v2');
    expect(result.content).toBe('APP_NAME=latest\n');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/example/project/tags');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal }));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.github.com/repos/example/project/contents/config/application.yml?ref=v2',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ signal }));
  });

  it('does not read the file when the repository has no usable tags', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{ name: '   ' }, {}]));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConfigFilePreviewService();

    await expect(
      service.preview({
        repositoryUrl: 'https://github.com/example/project.git',
        branch: 'main',
        filePath: 'config/application.yml',
        githubToken: 'test-token',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not read the file when resolving tags fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('forbidden', 403));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConfigFilePreviewService();

    await expect(
      service.preview({
        repositoryUrl: 'https://github.com/example/project.git',
        branch: 'main',
        filePath: 'config/application.yml',
        githubToken: 'test-token',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
