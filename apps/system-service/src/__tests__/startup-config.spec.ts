import { readFileSync, readdirSync } from 'node:fs';
import { matchesGlob, resolve } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it } from 'vitest';
import { AiTextClientService } from '../client/ai/ai-text-client.service';
import { OpenAiCompatibleChatModel } from '../client/ai/openai-compatible-chat-model';
import { ExternalHttpClientService } from '../client/external/external-http-client.service';
import { FeishuSheetGatewayService } from '../client/feishu/feishu-sheet-gateway.service';
import { GithubCommitsClientService } from '../client/github/github-commits-client.service';
import { AiTextCapabilityService } from '../modules/workflow-capabilities/ai-text-capability.service';
import { FeishuSheetCapabilityService } from '../modules/workflow-capabilities/feishu-sheet-capability.service';
import { GithubCommitsCapabilityService } from '../modules/workflow-capabilities/github-commits-capability.service';
import { WorkflowCapabilityController } from '../modules/workflow-capabilities/workflow-capability.controller';
import { WorkflowCapabilityHttpService } from '../modules/workflow-capabilities/workflow-capability-http.service';

interface PackageManifest {
  scripts?: Record<string, string>;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as PackageManifest;
}

describe('system startup build contract', () => {
  it('builds common-service with alias rewriting before every startup mode', () => {
    const systemPackage = readManifest('package.json');
    const commonPackage = readManifest('../common-service/package.json');
    const scripts = systemPackage.scripts ?? {};

    expect(scripts['build:common']).toBe('pnpm --dir ../common-service run build');
    expect(scripts['build:workflow']).toBe('node scripts/build-workflow.mjs');
    expect(scripts.build).toBe('pnpm run build:workflow && nest build');
    for (const hook of ['prestart', 'prestart:dev', 'prestart:debug', 'prestart:prod']) {
      expect(scripts[hook]).toBe('pnpm run build:workflow && pnpm run build:common');
    }
    expect(commonPackage.scripts?.build).toContain('tsc-alias');
  });

  it('watches deployable files without subscribing to atomic editor temporary files', () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'nest-cli.json'), 'utf8')) as {
      sourceRoot: string;
      compilerOptions: { assets: { include: string; exclude: string; outDir: string }[] };
    };
    const assets = config.compilerOptions.assets[0];
    const sourceRoot = resolve(process.cwd(), config.sourceRoot);
    const included = (file: string) =>
      matchesGlob(resolve(process.cwd(), 'public', file), resolve(sourceRoot, assets.include));
    for (const file of [
      'index.html',
      'js/workflow-core.js',
      'vendor/workflow-graph.js',
      'css/workflow.css',
      'images/logo.svg',
      'fonts/body.woff2',
    ]) {
      expect(included(file)).toBe(true);
    }
    expect(included('css')).toBe(false);
    expect(included('css/workflow.css.tmp.1234.abcd')).toBe(false);
    expect(
      matchesGlob(
        resolve(process.cwd(), 'public/css/workflow.css.tmp.1234.abcd'),
        resolve(sourceRoot, assets.exclude),
      ),
    ).toBe(true);
    expect(assets.outDir).toBe('dist/public');
  });
});

describe('workflow capability startup registration', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('mounts the sensitive HTTP boundary from main.ts configureApp', () => {
    const main = read('src/main.ts');
    const configureApp = main.slice(main.indexOf('configureApp'));
    expect(main).toContain('modules/workflow-capabilities/workflow-capability-http.service');
    expect(configureApp).toContain('app.get(WorkflowCapabilityHttpService).mount(app);');
    // 既有的两个专用边界保持挂载
    expect(configureApp).toContain('app.get(ContentCompareHttpService).mount(app);');
  });

  it('exposes the four endpoints and their services through the existing auto registration', () => {
    expect(Reflect.hasMetadata('__controller__', WorkflowCapabilityController)).toBe(true);
    expect(Reflect.getMetadata('path', WorkflowCapabilityController)).toBe(
      'api/workflow-capabilities',
    );
    for (const provider of [
      ExternalHttpClientService,
      GithubCommitsClientService,
      AiTextClientService,
      FeishuSheetGatewayService,
      GithubCommitsCapabilityService,
      AiTextCapabilityService,
      FeishuSheetCapabilityService,
      WorkflowCapabilityHttpService,
    ]) {
      expect(Reflect.hasMetadata('__injectable__', provider)).toBe(true);
    }

    const paths = ['githubCommits', 'aiText', 'feishuFindRow', 'feishuWriteCells'].map((method) =>
      Reflect.getMetadata(
        'path',
        (WorkflowCapabilityController.prototype as unknown as Record<string, () => void>)[method],
      ),
    );
    expect(paths).toEqual(['github-commits', 'ai-text', 'feishu-find-row', 'feishu-write-cells']);
  });

  it('registers one dependency-free LangChain AI client that does not use ExternalHttp or fetch', () => {
    expect(AiTextClientService.length).toBe(0);
    expect(Reflect.getMetadata('design:paramtypes', AiTextClientService)).toBeUndefined();
    expect(Object.getPrototypeOf(OpenAiCompatibleChatModel.prototype)).toBe(
      BaseChatModel.prototype,
    );
    for (const file of ['ai-text-client.service.ts', 'openai-compatible-chat-model.ts']) {
      const source = readFileSync(resolve(process.cwd(), 'src/client/ai', file), 'utf8');
      expect(source).not.toMatch(/ExternalHttp|\bfetch\b|openai-compatible-client/);
    }
  });

  it('adds no business Module class', () => {
    const directory = resolve(process.cwd(), 'src/modules/workflow-capabilities');
    for (const entry of readdirSync(directory, { recursive: true, encoding: 'utf8' })) {
      if (!entry.endsWith('.ts')) continue;
      expect(readFileSync(resolve(directory, entry), 'utf8')).not.toMatch(/@Module\(/);
    }
  });
});
