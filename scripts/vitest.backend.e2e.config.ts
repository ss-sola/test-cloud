import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const setupFile = path.join(scriptDirectory, 'vitest.backend.setup.ts');

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/**/*.e2e-spec.ts'],
    passWithNoTests: true,
    setupFiles: [setupFile],
  },
});
