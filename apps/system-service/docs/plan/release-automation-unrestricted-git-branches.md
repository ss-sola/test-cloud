# 发布自动化 Git 分支限制移除计划

## 背景

`release-automation` 页面原先通过 HTML、DTO、Job 与 merge service 将 Git 分支限制为 `custom/*`。第一轮实现曾将该业务前缀规则替换为统一 Git 分支格式校验；2026-09-11 用户进一步明确要求去掉所有分支格式校验，因此最终实现不再判断 Git 分支名称格式，仅保留请求字段的字符串、非空与最大长度边界。

本次仅修改 `system-service`，禁止修改 `apps/common-service`；不涉及数据库、Redis、权限、路由、服务端持久化或真实外部网络调用。

## 任务清单

| # | 任务 | 阶段 | 状态 | 开始时间 | 结束时间 | 耗时 |
|---|------|------|------|----------|----------|------|
| 1 | 调研页面与后端分支限制调用链 | 分析 | 已完成 | 2026-09-11 18:00 +08:00 | 2026-09-11 18:08 +08:00 | 8 分钟 |
| 2 | 实现并评审统一分支格式校验 | 初始实现 | 已撤销 | 2026-09-11 18:08 +08:00 | 2026-09-11 18:31 +08:00 | 23 分钟 |
| 3 | 按追加要求移除全部分支格式校验 | 最终实现 | 已完成 | 2026-09-11 18:32 +08:00 | 2026-09-11 19:04 +08:00 | 32 分钟 |
| 4 | 同步测试与正式文档 | 测试与文档 | 已完成 | 2026-09-11 18:34 +08:00 | 2026-09-11 19:05 +08:00 | 31 分钟 |
| 5 | 执行 lint、test、tsgo | 验证 | 已完成 | 2026-09-11 19:05 +08:00 | 2026-09-11 19:06 +08:00 | 1 分钟 |

## 最终设计

### 页面

- `release-automation.html` 的 Git 分支输入不设置 `pattern`，不限制 `custom/*` 或其他名称格式。
- 保留 `required` 和 `maxlength="256"`，避免缺失值及无界请求。
- `release-automation.js`、localStorage key/schema、payload 字段及 `branch`/`targetBranch` 同值发送逻辑保持不变。

### 后端

- `CreateReleaseAutomationJobDto.targetBranch` 与 `branch` 只保留 `@IsString()`、`@IsNotEmpty()`、`@MaxLength(256)`。
- `ReleaseAutomationJobService`、`ReleaseAutomationService.getBranchRef`、`ReleaseAutomationService.mergeBranch` 不执行分支名称格式判断。
- `GitHubReleaseClientService.merge` 不执行 branch 专用格式判断，直接将 base/head 放入 GitHub API 请求体。
- 删除本轮新增的 branch validator 文件；已有通用 GitHub ref、URL 和传输安全逻辑不在本次范围内。
- `listBranches` 与未接入页面执行链的 `planBranches` 保持现状，避免扩大分支枚举与远程请求规模。

### 测试

- 删除专门验证 Git 分支名称格式的测试。
- 保留 `release/v1`、`main` 等非 `custom/*` 分支可通过 Job、service 和 GitHub client 路径的正向回归。
- 静态页面测试断言 Git 分支 input 不存在 `pattern` 属性。
- 不增加字符串格式用例矩阵。

### 文档

- `HTTP-API.md` 明确两个分支字段不执行格式校验，仅保留基本字段边界。
- `配置与安全边界.md` 与 `外部适配器.md` 同步最终行为。
- `Job状态与幂等.md` 保留此前纠正的 tag 来源分支与 merge 目标分支说明。

## 文件影响范围汇总

| 文件/目录 | 变更类型 | 说明 |
|-----------|----------|------|
| `apps/system-service/src/modules/release-automation/dto/release-automation.dto.ts` | 修改 | 移除 `custom/*` 格式规则 |
| `apps/system-service/src/modules/release-automation/release-automation-job.service.ts` | 修改 | 移除 Job 层分支格式判断 |
| `apps/system-service/src/modules/release-automation/release-automation.service.ts` | 修改 | 移除 ref/merge 分支格式判断 |
| `apps/system-service/src/modules/release-automation/github-release-client.service.ts` | 修改 | 移除 merge branch 专用格式判断 |
| `apps/system-service/public/html/release-automation.html` | 修改 | 移除 input pattern 并更新提示 |
| `apps/system-service/src/__tests__/release-automation-job.spec.ts` | 修改 | 使用非 custom 分支验证 Job |
| `apps/system-service/src/__tests__/release-automation-git-service.spec.ts` | 修改 | 使用非 custom 分支验证执行服务 |
| `apps/system-service/src/__tests__/release-automation-adapters.spec.ts` | 修改 | 使用非 custom 分支验证 GitHub client |
| `apps/system-service/src/__tests__/frontend-logic.spec.ts` | 修改 | 断言页面没有 branch pattern |
| `apps/system-service/docs/release-automation/HTTP-API.md` | 修改 | 更新接口分支语义 |
| `apps/system-service/docs/release-automation/外部适配器.md` | 修改 | 更新 GitHub merge 分支行为 |
| `apps/system-service/docs/release-automation/配置与安全边界.md` | 修改 | 更新页面与 DTO 边界 |
| `apps/system-service/docs/release-automation/Job状态与幂等.md` | 修改 | 纠正 tag 来源说明 |
| `apps/system-service/docs/plan/release-automation-unrestricted-git-branches.md` | 新增 | 实施与需求变更记录 |

## 验证步骤

1. 运行受影响 release automation 与 frontend logic 测试。
2. 在仓库根目录运行 `pnpm run lint`。
3. 在仓库根目录运行 `pnpm run test`。
4. 在仓库根目录运行 `pnpm run tsgo`。
5. 检查 git diff，确认未修改 `apps/common-service`。

## 开始时间

2026-09-11 18:00 +08:00

## 结束时间

2026-09-11 19:06 +08:00

## 耗时

1 小时 6 分钟

## 当前状态

已完成
