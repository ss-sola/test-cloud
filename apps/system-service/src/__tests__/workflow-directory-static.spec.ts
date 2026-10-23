import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AbstractLoader } from '@nestjs/serve-static/dist/loaders/abstract.loader';
import { ExpressLoader } from '@nestjs/serve-static/dist/loaders/express.loader';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sandbox = vi.hoisted(() => ({ root: '' }));
vi.mock('../constants/workflow-directory.constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get WORKFLOW_DIRECTORY_ROOT() {
    return sandbox.root;
  },
}));

let app: INestApplication;
let temporaryRoot: string;
let configuredRoot: string;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(resolve(__dirname, '../..'), '.workflow-directory-static-'));
  sandbox.root = join(temporaryRoot, 'workflow');
  await mkdir(sandbox.root);
  const { AppModule } = await import('../app.module');
  const staticModule = Reflect.getMetadata('imports', AppModule)[0] as {
    providers: { useValue: { rootPath: string }[] }[];
  };
  configuredRoot = staticModule.providers[0].useValue[0].rootPath;
  // TestingModule 编译时尚无 HTTP 适配器，默认会选空加载器；正式启动使用 Express 加载器。
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AbstractLoader)
    .useClass(ExpressLoader)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe('固定项目目录静态映射', () => {
  it('直接读取固定根中的新文件和更新，不依赖构建复制或启动 cwd', async () => {
    expect(configuredRoot).toBe(sandbox.root);
    const target = join(sandbox.root, 'fresh.json');
    await writeFile(target, '{"version":"first"}');
    const first = await request(app.getHttpServer()).get('/public/workflow/fresh.json');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ version: 'first' });
    await writeFile(target, '{"version":"second"}');
    const second = await request(app.getHttpServer()).get('/public/workflow/fresh.json');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ version: 'second' });
  });

  it('临时文件和临时锁不能通过静态路径读取', async () => {
    await writeFile(join(sandbox.root, '.flow.json.tmp.test'), 'temporary secret');
    await writeFile(join(sandbox.root, '.workflow-write.tmp.lock'), 'temporary lock');
    for (const filename of ['.flow.json.tmp.test', '.workflow-write.tmp.lock']) {
      const result = await request(app.getHttpServer()).get(`/public/workflow/${filename}`);
      expect([403, 404]).toContain(result.status);
      expect(result.text).not.toContain('temporary');
    }
  });

  it('缺失文件不渲染页面或回退到其他静态目录', async () => {
    const result = await request(app.getHttpServer()).get('/public/workflow/missing.json');
    expect(result.status).toBe(404);
    expect(result.text).not.toContain('<!DOCTYPE html>');
  });
});
