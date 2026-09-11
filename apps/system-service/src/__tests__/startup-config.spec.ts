import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    expect(scripts.prestart).toBe('pnpm run build:common');
    expect(scripts['prestart:dev']).toBe('pnpm run build:common');
    expect(scripts['prestart:debug']).toBe('pnpm run build:common');
    expect(scripts['prestart:prod']).toBe('pnpm run build:common');
    expect(commonPackage.scripts?.build).toContain('tsc-alias');
  });
});
