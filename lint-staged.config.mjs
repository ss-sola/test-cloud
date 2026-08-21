/**
 * lint-staged 配置（monorepo）
 *
 * - oxfmt: 统一处理暂存文件格式
 * - oxlint: 统一走根目录 Oxc 配置和共享 runner
 */

export default {
  "*.{js,mjs,cjs,json,md,yml,yaml}": ["oxfmt --write"],

  // 格式化与 oxlint 共用一套根级规则入口（.d.ts 声明文件不参与 lint）
  "apps/**/*.ts": [
    "oxfmt --write",
    (files) => {
      const targets = files.filter((f) => !f.endsWith(".d.ts")).join(" ");
      return targets
        ? `node scripts/run-oxlint.mjs --strict ${targets}`
        : 'node -e "process.exit(0)"';
    },
  ],
};
