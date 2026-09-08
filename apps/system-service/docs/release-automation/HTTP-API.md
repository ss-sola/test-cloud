# HTTP API

## 创建执行 Job

```http
POST /api/release-automation/jobs
Idempotency-Key: release-20260904-001
Content-Type: application/json
```

请求 body 使用 `CreateReleaseAutomationJobDto`：

```json
{
  "repository": "acme/project",
  "gitAddress": "https://github.com/acme/project.git",
  "targetBranch": "custom/prod",
  "branch": "custom/prod",
  "gitTag": "v1.9.0-2026-09-04",
  "mode": "apply",
  "githubToken": "页面配置的 token",
  "jenkinsToken": "页面配置的 token",
  "jenkinsBaseUrl": "http://192.168.88.223:8080",
  "feishuAppId": "页面配置的 App ID",
  "feishuAppSecret": "页面配置的 App Secret",
  "tasks": ["git-tag", "github-merge", "jenkins", "release-docs", "modify-log", "feishu"]
}
```

`repository` 可省略并从 `gitAddress` 解析；`gitTag` 是用户输入的 release tag，格式例如 `v1.9.0-2026-09-04`，不再要求用户提交候选 commit SHA。创建 Job 会按勾选任务执行真实外部操作；Git tag 以选定 `targetBranch` 的当前 SHA 为快照，分支合并使用 `dev/master` 单一来源分支。`mode` 省略时默认为 `apply`；显式使用 `mode: "dry-run"` 时只跳过 GitHub tag/merge 写操作，但选中的 Jenkins package 仍会直接调用 Jenkins 接口。`apply` 仍要求幂等 key 满足 GitHub 写 gate，并通过 repository 格式、GitHub host、凭据和 SHA 校验。缺失/非法 Idempotency-Key、分支、gitTag 或 Git 地址返回 400/403；容量超限返回 429。成功返回 HTTP 202 和 `ResponseUtil.success` envelope。

相同 `Idempotency-Key + release unit + payloadHash` 返回相同 Job（`idempotent=true`）；同一 Job ID 的 payload hash 不同返回 409。页面 token 不写入进度文本、错误消息、Markdown 或日志；它会随 Job 数据用于后续执行。

## 查询状态

```http
GET /api/release-automation/jobs/status?jobId=release-...
```

参数使用 `GetReleaseAutomationStatusDto`，成功返回 200 和 `ResponseUtil.success` envelope；格式非法返回 400，不存在/过期返回 404。Controller 只做 DTO 解析与 response wrapping，阶段成功以服务端 `progress.sequence` 为准，页面不得自行计算。

## 副作用执行边界

创建 Job 会按 `tasks` 执行真实 GitHub/Jenkins 操作；Feishu 当前按用户要求标记 skipped。每个任务仍使用幂等判断和 release unit 校验，冲突或来源 SHA 变化会阻断。`modify-log.sql` 清空和远程 tag/merge 失败时保留已生成 artifact 与日志，不自动重试不确定的写操作。

## 测试同步执行

```http
POST /api/release-automation/test/execute
Idempotency-Key: release-sync-test-001
Content-Type: application/json
```

该接口复用 `CreateReleaseAutomationJobDto`，但不创建 BullMQ Job、不读取或写入 Redis，适合本地/集成测试。未传 `mode` 时默认使用 `dry-run`；只有 GitHub tag/merge 需要明确传入 `"mode": "apply"` 才允许真实写操作，选中的 Jenkins package 在两种 mode 下都会直接调用 Jenkins。请求体建议只选择 `git-tag`、`github-merge` 或 `jenkins`，避免未配置的后续任务阻断测试。

接口同步执行完成后返回 HTTP 200。HTTP 200 只表示同步执行已返回结果，业务是否成功以 `data.error` 和 `data.progress.stage` 判断；错误也会以 `data.error` 返回，不创建可通过 `/jobs/status` 查询的持久 Job。`Idempotency-Key` 仍是 apply 写操作所需的 gate，但同步接口不提供跨请求的持久幂等，重复 apply 可能再次执行外部步骤。
