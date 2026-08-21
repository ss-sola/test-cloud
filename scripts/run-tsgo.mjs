import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const appsDirectory = path.join(repoRoot, 'apps');
const webDirectory = path.join(repoRoot, 'web');
const tsgoEntry = path.join(
  repoRoot,
  'node_modules',
  '@typescript',
  'native-preview',
  'bin',
  'tsgo.js',
);

function getProjectConfigs() {
  const configs = [];

  // Scan apps/ directory
  if (fs.existsSync(appsDirectory)) {
    for (const entry of fs.readdirSync(appsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absConfig = path.join(appsDirectory, entry.name, 'tsconfig.json');
      if (fs.existsSync(absConfig)) {
        configs.push({
          projectName: entry.name,
          projectDirectory: path.join(appsDirectory, entry.name),
          configPath: path.join('apps', entry.name, 'tsconfig.json'),
          absoluteConfigPath: absConfig,
        });
      }
    }
  }

  // Scan web/ directory
  if (fs.existsSync(webDirectory)) {
    for (const entry of fs.readdirSync(webDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absConfig = path.join(webDirectory, entry.name, 'tsconfig.json');
      if (fs.existsSync(absConfig)) {
        configs.push({
          projectName: entry.name,
          projectDirectory: path.join(webDirectory, entry.name),
          configPath: path.join('web', entry.name, 'tsconfig.json'),
          absoluteConfigPath: absConfig,
        });
      }
    }
  }

  return configs.sort((a, b) => a.projectName.localeCompare(b.projectName));
}

const projects = getProjectConfigs();

if (projects.length === 0) {
  console.error('No tsconfig.json files found under apps/ or web/.');
  process.exit(1);
}

console.log('Building common-service declarations...');
const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const commonBuildResult = spawnSync(
  pnpmExecutable,
  ['--dir', path.join('apps', 'common-service'), 'run', 'build'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

if (commonBuildResult.error) {
  throw commonBuildResult.error;
}

if ((commonBuildResult.status ?? 1) !== 0) {
  process.exit(commonBuildResult.status ?? 1);
}

// Step 1: Build each project with nest build
// Generate a temporary tsconfig.build.json to exclude test files from dist output
for (const project of projects) {
  console.log(`Building ${project.projectName}...`);
  const buildConfig = {
    extends: './tsconfig.json',
    exclude: ['src/__tests__', 'src/**/*.spec.ts', 'src/**/*.e2e-spec.ts'],
  };
  const buildConfigPath = path.join(project.projectDirectory, 'tsconfig.build.json');
  fs.writeFileSync(buildConfigPath, JSON.stringify(buildConfig, null, 2));

  try {
    const buildResult = spawnSync(pnpmExecutable, ['run', 'build'], {
      cwd: project.projectDirectory,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if ((buildResult.status ?? 1) !== 0) {
      process.exit(buildResult.status ?? 1);
    }
  } finally {
    fs.rmSync(buildConfigPath, { force: true });
  }
}

// Step 2: Type check with tsgo (use original tsconfig to check all files including tests)
for (const project of projects) {
  console.log(`Type checking ${project.projectName} with tsgo...`);
  const result = spawnSync(
    process.execPath,
    [tsgoEntry, '--noEmit', '-p', project.absoluteConfigPath],
    {
      cwd: project.projectDirectory,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
