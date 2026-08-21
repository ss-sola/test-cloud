import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const appsDirectory = path.join(repoRoot, 'apps');
const webDirectory = path.join(repoRoot, 'web');

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

// ── 项目扫描 ──────────────────────────────────────────────

function scanProjectsWithLint(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageName = entry.name;
      const packageJsonPath = path.join(baseDir, packageName, 'package.json');
      if (!fs.existsSync(packageJsonPath)) return null;

      let packageJson;
      try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      } catch {
        return null;
      }

      if (!packageJson.scripts?.lint) return null;

      return { projectName: packageName, baseDir };
    })
    .filter(Boolean);
}

function getLintProjects() {
  const results = [];
  results.push(...scanProjectsWithLint(appsDirectory));
  results.push(...scanProjectsWithLint(webDirectory));
  return results.sort((a, b) => a.projectName.localeCompare(b.projectName));
}

// ── 并行执行 lint ─────────────────────────────────────────

function runProjectLint(project) {
  return new Promise((resolve) => {
    const projectDir = path.join(project.baseDir, project.projectName);
    const args = ['--dir', projectDir, 'run', 'lint'];

    const child = spawn(pnpmExecutable, args, {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32',
      env: { FORCE_COLOR: '1', ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ projectName: project.projectName, status: code ?? 1, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ projectName: project.projectName, status: 1, stdout, stderr: err.message });
    });
  });
}

// ── 主流程 ─────────────────────────────────────────────────

const projects = getLintProjects();

if (projects.length === 0) {
  console.error('No lint scripts found under apps/ or web/.');
  process.exit(1);
}

console.log(`Found ${projects.length} project(s) with lint scripts, running in parallel...\n`);

const startTime = Date.now();
const results = await Promise.allSettled(projects.map((p) => runProjectLint(p)));

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

const lintResults = results.map((r) => {
  if (r.status === 'fulfilled') return r.value;
  return { projectName: 'unknown', status: 1, stdout: '', stderr: String(r.reason) };
});

let hasFailures = false;
for (const result of lintResults) {
  const label = result.status === 0 ? 'PASS' : 'FAIL';
  if (result.status !== 0) hasFailures = true;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${label}] ${result.projectName} (exit: ${result.status})`);
  console.log(`${'='.repeat(60)}`);

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

const passed = lintResults.filter((r) => r.status === 0).length;
const failed = lintResults.filter((r) => r.status !== 0);
const total = lintResults.length;

if (failed.length > 0) {
  console.log('\nFailed projects:');
  for (const f of failed) {
    console.log(`  - ${f.projectName} (exit code: ${f.status})`);
  }
}

console.log(`\nPassed: ${passed}/${total}`);
console.log(`Total time: ${elapsed}s`);

if (hasFailures) {
  process.exit(1);
}
