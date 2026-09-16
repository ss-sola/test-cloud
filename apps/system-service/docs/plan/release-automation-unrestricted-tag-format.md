# 发布自动化 Git tag 与格式校验移除计划

## 背景

发布自动化此前在 DTO、Job、执行步骤、GitHub adapter、SQL renderer 和 Jenkins 输出解析中重复限制 Git tag、repository、ref、SHA 等值的格式。当前需求是让这些值作为字符串协议值交由外部系统判定，保留真实写操作 gate、URL/host 边界、远程响应基本结构、动态队列/构建一致性和 SQL 转义保护。

## 任务清单

| # | 任务 | 阶段 | 状态 | 开始时间 | 结束时间 | 耗时 |
|---|---|---|---|---|---|---|
| 1 | 梳理 tag、repository、ref、SHA 与其它格式校验调用链 | 分析 | 已完成 | 2026-09-16 15:20 +08:00 | 2026-09-16 15:38 +08:00 | 18 分钟 |
| 2 | 移除后端及 adapter 的值格式校验 | 实现 | 已完成 | 2026-09-16 15:46 +08:00 | 2026-09-16 15:50 +08:00 | 4 分钟 |
| 3 | 同步页面、测试和模块文档 | 实现 | 已完成 | 2026-09-16 15:46 +08:00 | 2026-09-16 15:50 +08:00 | 4 分钟 |
| 4 | 执行 lint、test、tsgo 与 diff 检查 | 验证 | 已完成 | 2026-09-16 15:50 +08:00 | 2026-09-16 15:51 +08:00 | 1 分钟 |

## 设计边界

- `gitTag` 不要求 SemVer 或固定字符集，Git tag 创建能力保留。
- repository、branch/ref、文件路径、SHA、release unit 元数据和 Jenkins Pipeline 输出 tag 不再执行本地业务格式/形状正则。
- GitHub URL 的 HTTPS、allowlist、同源、无凭据 query、禁止重定向和响应大小/超时限制保留。
- `assertWriteGate`、dry-run 写保护、Jenkins 动态 queue/build ID 与同源 Location、SQL 标识符/字符串转义和控制字符保护保留。
- 不修改 `apps/common-service`。

## 实现文件

- `src/modules/release-automation/release-automation.constants.ts`
- `dto/release-automation.dto.ts`
- `release-automation-execution.service.ts`
- `release-automation-job.service.ts`
- `release-automation.service.ts`
- `github-release-client.service.ts`
- `jenkins-client.service.ts`
- `version-sql.renderer.ts`
- `public/html/release-automation.html`
- 对应 release automation 与 frontend 测试
- `docs/release-automation/` 模块文档

## 验证结果

- 受影响回归测试：6 个文件、33 个测试通过；新增/调整覆盖非 SemVer tag、非十六进制 SHA、opaque repository/ref、非 `custom/*` 分支、SQL metadata 控制字符和页面 tag pattern。
- `pnpm run lint`：通过（common-service/system-service 均通过，未产生 common-service 工作区改动）。
- `pnpm run test`：通过（2/2 项目，system-service 26 个测试文件、137 个测试通过）。
- `pnpm run tsgo`：通过。
- `git diff --check`：通过。

## 当前状态

已完成（2026-09-16 15:51 +08:00）。
