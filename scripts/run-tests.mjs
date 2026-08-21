import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCoverageStats, pct } from './coverage-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const appsDirectory = path.join(repoRoot, 'apps');
const webDirectory = path.join(repoRoot, 'web');
const coverageDir = path.join(repoRoot, 'coverage');
const COVERAGE_DIR_NAME = 'coverage';
const COVERAGE_FINAL_JSON = 'coverage-final.json';

// ── 项目扫描 ──────────────────────────────────────────────

function scanTestProjects(baseDir, dirLabel) {
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

      if (!packageJson.scripts?.test) return null;

      return { projectName: packageName, baseDir, dirLabel };
    })
    .filter(Boolean);
}

function getTestProjects() {
  const results = [];
  results.push(...scanTestProjects(appsDirectory, 'apps'));
  results.push(...scanTestProjects(webDirectory, 'web'));
  return results.sort((a, b) => a.projectName.localeCompare(b.projectName));
}

// ── 测试统计解析 ──────────────────────────────────────────

/**
 * 从 vitest stdout 中解析测试用例统计。
 * 匹配格式如：
 *   "Test Files  10 passed (10)"
 *   "Tests  25 passed (25)"
 *   "Tests  48 passed | 2 failed (50)"
 *   "Tests  2 failed | 114 passed (116)"  （失败在前时也能正确解析）
 */
function parseTestStats(rawStdout) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // 剥离 ANSI 颜色转义码（如 \x1b[32m、\x1b[22m 等）
  const stdout = rawStdout.replace(/\x1b\[\d*(;\d+)*m/g, '');

  // 匹配 Tests 行，数字顺序可能不同（如 "Tests  2 failed | 114 passed (116)"）
  const testsLine = stdout.match(/^\s*Tests\s+(.+)$/m);
  if (testsLine) {
    const line = testsLine[1];
    const pm = line.match(/(\d+)\s*passed/);
    const fm = line.match(/(\d+)\s*failed/);
    const sm = line.match(/(\d+)\s*skipped/);
    if (pm) passed = Number(pm[1]);
    if (fm) failed = Number(fm[1]);
    if (sm) skipped = Number(sm[1]);
  }

  // 回退：Passed: 5 | Failed: 2 | Skipped: 1
  if (passed === 0 && failed === 0 && skipped === 0) {
    const pm = stdout.match(/Passed:\s*(\d+)/);
    const fm = stdout.match(/Failed:\s*(\d+)/);
    const sm = stdout.match(/Skipped:\s*(\d+)/);
    if (pm) passed = Number(pm[1]);
    if (fm) failed = Number(fm[1]);
    if (sm) skipped = Number(sm[1]);
  }

  const total = passed + failed + skipped;
  if (total === 0) return {};
  return {
    testPassed: passed,
    testFailed: failed,
    testSkipped: skipped,
    testTotal: total,
    testPassRate: pct(passed, total),
  };
}

// ── 并行执行测试 ──────────────────────────────────────────

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function runProjectTest(project) {
  return new Promise((resolve) => {
    const projectDir = path.join(project.dirLabel, project.projectName);
    const args = ['--dir', projectDir, 'run', 'test', '--passWithNoTests', '--coverage'];

    const child = spawn(pnpmExecutable, args, {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32',
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
      // Windows 下 shell:true 时 vitest 输出可能走 stderr，合并解析
      const combined = stdout + stderr;
      const testStats = parseTestStats(combined);
      resolve({
        projectName: project.projectName,
        dirLabel: project.dirLabel,
        status: code ?? 1,
        stdout,
        stderr,
        ...testStats,
      });
    });

    child.on('error', (err) => {
      const combined = stdout + stderr;
      const testStats = parseTestStats(combined);
      resolve({
        projectName: project.projectName,
        dirLabel: project.dirLabel,
        status: 1,
        stdout,
        stderr: stderr + err.message,
        error: err,
        ...testStats,
      });
    });
  });
}

// ── 覆盖率收集与汇总 ──────────────────────────────────────

function collectCoverage(projects) {
  // 重建根 coverage/ 目录
  if (fs.existsSync(coverageDir)) {
    fs.rmSync(coverageDir, { recursive: true, force: true });
  }
  fs.mkdirSync(coverageDir, { recursive: true });

  const projectResults = [];

  for (const project of projects) {
    const projectBase = path.join(project.baseDir, project.projectName);
    const coverageJsonPath = path.join(projectBase, COVERAGE_DIR_NAME, COVERAGE_FINAL_JSON);

    if (!fs.existsSync(coverageJsonPath)) {
      projectResults.push({
        projectName: project.projectName,
        hasCoverage: false,
      });
      continue;
    }

    // 复制到根 coverage/<projectName>/
    const destDir = path.join(coverageDir, project.projectName);
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.cpSync(path.join(projectBase, COVERAGE_DIR_NAME), destDir, {
        recursive: true,
        force: true,
      });

      // 解析覆盖率数据
      const coverageData = JSON.parse(fs.readFileSync(coverageJsonPath, 'utf8'));
      const stats = computeCoverageStats(coverageData);

      projectResults.push({
        projectName: project.projectName,
        hasCoverage: true,
        ...stats,
      });
    } catch {
      projectResults.push({
        projectName: project.projectName,
        hasCoverage: false,
      });
    }
  }

  return projectResults;
}

function generateSummary(projectResults, testResults) {
  const lines = [];

  lines.push('# 测试覆盖率汇总');
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push('');

  // 概览表
  lines.push('## 概览');
  lines.push('');
  lines.push(
    '| 项目 | 测试通过率 | 语句覆盖率 | 分支覆盖率 | 函数覆盖率 | 行覆盖率 | 覆盖文件数 |',
  );
  lines.push('|------|-----------|-----------|-----------|-----------|---------|-----------|');

  let globalCoveredS = 0;
  let globalTotalS = 0;
  let globalCoveredB = 0;
  let globalTotalB = 0;
  let globalCoveredF = 0;
  let globalTotalF = 0;
  let globalCoveredL = 0;
  let globalTotalL = 0;
  let globalFiles = 0;
  let globalTestPassed = 0;
  let globalTestTotal = 0;

  const testMap = new Map();
  for (const t of testResults) {
    testMap.set(t.projectName, t);
  }

  for (const r of projectResults) {
    const testInfo = testMap.get(r.projectName);
    let testRateStr = '-';
    if (testInfo && testInfo.testTotal > 0) {
      testRateStr = `${testInfo.testPassRate}%（${testInfo.testPassed}/${testInfo.testTotal}）`;
    } else if (testInfo && testInfo.status === 0) {
      testRateStr = '100%（无测试用例）';
    } else {
      testRateStr = 'N/A';
    }

    if (r.hasCoverage) {
      lines.push(
        `| ${r.projectName} | ${testRateStr} | ${r.statements.pct}% | ${r.branches.pct}% | ${r.functions.pct}% | ${r.lines.pct}% | ${r.fileCount} |`,
      );
      globalCoveredS += r.statements.covered;
      globalTotalS += r.statements.total;
      globalCoveredB += r.branches.covered;
      globalTotalB += r.branches.total;
      globalCoveredF += r.functions.covered;
      globalTotalF += r.functions.total;
      globalCoveredL += r.lines.covered;
      globalTotalL += r.lines.total;
      globalFiles += r.fileCount;
      if (testInfo) {
        globalTestPassed += testInfo.testPassed || 0;
        globalTestTotal += testInfo.testTotal || 0;
      }
    } else {
      lines.push(`| ${r.projectName} | ${testRateStr} | - | - | - | - | 未生成覆盖率数据 |`);
    }
  }

  // 全局汇总行
  const globalTestRate = pct(globalTestPassed, globalTestTotal);
  lines.push(
    `| **总计** | **${globalTestRate}%（${globalTestPassed}/${globalTestTotal}）** | **${pct(globalCoveredS, globalTotalS)}%** | **${pct(globalCoveredB, globalTotalB)}%** | **${pct(globalCoveredF, globalTotalF)}%** | **${pct(globalCoveredL, globalTotalL)}%** | **${globalFiles}** |`,
  );

  // 详细数据
  lines.push('');
  lines.push('## 详细数据');
  lines.push('');

  for (const r of projectResults) {
    const testInfo = testMap.get(r.projectName);

    if (!r.hasCoverage) {
      lines.push(`### ${r.projectName}`);
      lines.push('');
      lines.push('未生成覆盖率数据。');
      if (testInfo && testInfo.testTotal > 0) {
        lines.push(
          `- 测试通过率：${testInfo.testPassRate}%（${testInfo.testPassed}/${testInfo.testTotal}）`,
        );
      }
      lines.push('');
      continue;
    }

    lines.push(`### ${r.projectName}`);
    lines.push('');
    if (testInfo && testInfo.testTotal > 0) {
      lines.push(
        `- 测试通过率：${testInfo.testPassRate}%（${testInfo.testPassed} 通过 / ${testInfo.testFailed} 失败 / ${testInfo.testSkipped} 跳过）`,
      );
    } else if (testInfo && testInfo.status === 0) {
      lines.push('- 测试通过率：100%（无测试用例）');
    }
    lines.push(
      `- 语句覆盖率：${r.statements.pct}%（${r.statements.covered}/${r.statements.total}）`,
    );
    lines.push(`- 分支覆盖率：${r.branches.pct}%（${r.branches.covered}/${r.branches.total}）`);
    lines.push(`- 函数覆盖率：${r.functions.pct}%（${r.functions.covered}/${r.functions.total}）`);
    lines.push(`- 行覆盖率：${r.lines.pct}%（${r.lines.covered}/${r.lines.total}）`);
    lines.push(`- 覆盖文件数：${r.fileCount}`);

    if (r.uncoveredFunctions.length > 0) {
      lines.push('');
      lines.push('**未覆盖函数（前 10 条）：**');
      for (const fn of r.uncoveredFunctions) {
        lines.push(`  - ${fn}`);
      }
    }

    if (r.uncoveredLines.length > 0) {
      lines.push('');
      lines.push('**未覆盖行（前 10 条）：**');
      for (const ln of r.uncoveredLines) {
        lines.push(`  - ${ln}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ── 主流程 ─────────────────────────────────────────────────

const projects = getTestProjects();

if (projects.length === 0) {
  console.error('No test scripts found under apps/ or web/.');
  process.exit(1);
}

console.log(`Found ${projects.length} project(s) with test scripts, running in parallel...\n`);

const startTime = Date.now();

// 并行执行所有项目测试
const results = await Promise.allSettled(projects.map((p) => runProjectTest(p)));

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

// 提取结果（Promise.allSettled 不会 reject，但保留防御）
const testResults = results.map((r) => {
  if (r.status === 'fulfilled') return r.value;
  return { projectName: 'unknown', status: 1, stdout: '', stderr: String(r.reason) };
});

// 打印每个项目的日志
let hasFailures = false;
for (const result of testResults) {
  const label = result.status === 0 ? 'PASS' : 'FAIL';
  if (result.status !== 0) hasFailures = true;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[${label}] ${result.projectName} (exit: ${result.status})`);
  console.log(`${'═'.repeat(60)}`);

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

// 失败汇总
console.log(`\n${'═'.repeat(60)}`);
console.log('Test Summary');
console.log(`${'═'.repeat(60)}`);

const passed = testResults.filter((r) => r.status === 0).length;
const failed = testResults.filter((r) => r.status !== 0);
const total = testResults.length;
const passRate = pct(passed, total);

if (failed.length > 0) {
  console.log('\nFailed projects:');
  for (const f of failed) {
    console.log(`  - ${f.projectName} (exit code: ${f.status})`);
  }
}

console.log(`\nPassed: ${passed}/${total} (${passRate}%)`);
console.log(`Total time: ${elapsed}s`);

// 覆盖率收集与汇总（无论测试成功与否，有产物就收集）
console.log(`\n${'═'.repeat(60)}`);
console.log('Coverage Collection');
console.log(`${'═'.repeat(60)}`);

const coverageResults = collectCoverage(projects);
const summary = generateSummary(coverageResults, testResults);

const summaryPath = path.join(coverageDir, 'summary.md');
fs.writeFileSync(summaryPath, summary, 'utf8');

console.log(`Coverage summary written to coverage/summary.md`);

// 打印覆盖率概览
const hasCoverage = coverageResults.filter((r) => r.hasCoverage);
if (hasCoverage.length > 0) {
  console.log(
    `\nCoverage data collected from ${hasCoverage.length}/${projects.length} project(s):`,
  );
  for (const r of hasCoverage) {
    console.log(
      `  ${r.projectName}: statements ${r.statements.pct}%, branches ${r.branches.pct}%, functions ${r.functions.pct}%, lines ${r.lines.pct}%`,
    );
  }
}

const noCoverage = coverageResults.filter((r) => !r.hasCoverage);
if (noCoverage.length > 0) {
  console.log(`\nNo coverage data from: ${noCoverage.map((r) => r.projectName).join(', ')}`);
}

// 退出码：任一失败则非零
if (hasFailures) {
  process.exit(1);
}
