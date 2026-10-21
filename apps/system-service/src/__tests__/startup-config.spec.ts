import { readFileSync } from 'node:fs';
import { matchesGlob, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    const included = (file: string) => matchesGlob(resolve(process.cwd(), 'public', file), resolve(sourceRoot, assets.include));
    for (const file of ['index.html', 'js/workflow-core.js', 'vendor/workflow-graph.js', 'css/workflow.css', 'images/logo.svg', 'fonts/body.woff2']) {
      expect(included(file)).toBe(true);
    }
    expect(included('css')).toBe(false);
    expect(included('css/workflow.css.tmp.1234.abcd')).toBe(false);
    expect(matchesGlob(resolve(process.cwd(), 'public/css/workflow.css.tmp.1234.abcd'), resolve(sourceRoot, assets.exclude))).toBe(true);
    expect(assets.outDir).toBe('dist/public');
  });
});
