import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const setupFile = path.join(scriptDirectory, 'vitest.backend.setup.ts');

const repoRoot = path.resolve(scriptDirectory, '..');
const commonSrc = path.join(repoRoot, 'apps', 'common-service', 'src', 'index.ts');

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@nest-cloud/common': commonSrc,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/**/*.spec.ts'],
    exclude: ['src/__tests__/**/*.e2e-spec.ts'],
    passWithNoTests: true,
    setupFiles: [setupFile],
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/app.module.ts',
        'src/**/*.module.ts',
        'src/**/*.controller.ts',
        'src/**/*.dto.ts',
        'src/**/*.entity.ts',
      ],
    },
  },
});
