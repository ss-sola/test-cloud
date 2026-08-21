import path from 'node:path';

/**
 * 覆盖率数据计算工具 — 从 run-tests.mjs 提取的纯函数，便于独立测试。
 */

/**
 * 计算百分比，total 为 0 时返回 100。
 */
export function pct(covered, total) {
  if (total === 0) return 100;
  return Math.round((covered / total) * 10000) / 100;
}

/**
 * 解析 Istanbul JSON 覆盖率数据，计算各维度覆盖率统计。
 * @param {Record<string, object>} coverageData — coverage-final.json 的内容
 * @returns {object} 覆盖率统计结果
 */
export function computeCoverageStats(coverageData) {
  let totalStatements = 0;
  let coveredStatements = 0;
  let totalBranches = 0;
  let coveredBranches = 0;
  let totalFunctions = 0;
  let coveredFunctions = 0;
  let totalLines = 0;
  let coveredLines = 0;
  let fileCount = 0;

  const uncoveredFunctions = [];
  const uncoveredLines = [];

  for (const [filePath, fileData] of Object.entries(coverageData)) {
    fileCount++;

    // 语句覆盖率
    const s = fileData.s || {};
    const sKeys = Object.keys(s);
    totalStatements += sKeys.length;
    coveredStatements += sKeys.filter((k) => s[k] > 0).length;

    // 分支覆盖率
    const b = fileData.b || {};
    for (const branchArms of Object.values(b)) {
      if (Array.isArray(branchArms)) {
        totalBranches += branchArms.length;
        coveredBranches += branchArms.filter((v) => v > 0).length;
      }
    }

    // 函数覆盖率
    const f = fileData.f || {};
    const fKeys = Object.keys(f);
    totalFunctions += fKeys.length;
    coveredFunctions += fKeys.filter((k) => f[k] > 0).length;

    // 收集未覆盖函数（限 10 条）
    if (uncoveredFunctions.length < 10) {
      const fnMap = fileData.fnMap || {};
      for (const key of fKeys) {
        if (f[key] === 0 && uncoveredFunctions.length < 10) {
          const fnName = fnMap[key]?.name || '<anonymous>';
          const fnLoc = fnMap[key]?.loc
            ? `${path.basename(filePath)}:${fnMap[key].loc.start.line}`
            : path.basename(filePath);
          uncoveredFunctions.push(`${fnName} (${fnLoc})`);
        }
      }
    }

    // 行覆盖率（通过 statementMap 推导）
    const statementMap = fileData.statementMap || {};
    const coveredLineSet = new Set();
    const allLineSet = new Set();
    for (const [sKey, sVal] of Object.entries(s)) {
      const stmt = statementMap[sKey];
      if (stmt) {
        for (let line = stmt.start.line; line <= stmt.end.line; line++) {
          allLineSet.add(line);
          if (sVal > 0) coveredLineSet.add(line);
        }
      }
    }
    totalLines += allLineSet.size;
    coveredLines += coveredLineSet.size;

    // 收集未覆盖行（限 10 条）
    if (uncoveredLines.length < 10) {
      for (const line of allLineSet) {
        if (!coveredLineSet.has(line) && uncoveredLines.length < 10) {
          uncoveredLines.push(`${path.basename(filePath)}:${line}`);
        }
      }
    }
  }

  return {
    fileCount,
    statements: {
      covered: coveredStatements,
      total: totalStatements,
      pct: pct(coveredStatements, totalStatements),
    },
    branches: {
      covered: coveredBranches,
      total: totalBranches,
      pct: pct(coveredBranches, totalBranches),
    },
    functions: {
      covered: coveredFunctions,
      total: totalFunctions,
      pct: pct(coveredFunctions, totalFunctions),
    },
    lines: { covered: coveredLines, total: totalLines, pct: pct(coveredLines, totalLines) },
    uncoveredFunctions,
    uncoveredLines,
  };
}
