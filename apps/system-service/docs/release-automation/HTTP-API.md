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
  "targetBranch": "release/v1",
  "branch": "release/v1",
  "gitTag": "v1.9.0-2026-09-04",
  "mode": "apply",
  "runtime": {
    "ai": {
      "baseUrl": "https://ai.example.com/v1",
      "apiKey": "Token 配置中的 AI API Key",
      "model": "release-model"
    }
  },
  "releaseDocs": {},
  "githubToken": "页面配置的 token",
  "jenkinsToken": "页面配置的 token",
  "jenkinsBaseUrl": "http://jenkins.example.com/job/package",
  "jenkinsTagMarker": "image-name",
  "feishuAppId": "页面配置的 App ID",
  "feishuAppSecret": "页面配置的 App Secret",
  "githubBaseUrl": "https://api.github.com",
  "githubAllowedHosts": "api.github.com",
  "environmentFilePath": "env/sample/app.env",
  "modifyLogPath": ".version/modify-log.sql",
  "tasks": ["git-tag", "github-merge", "jenkins", "release-docs", "modify-log"]
}
```

`repository` 可省略并从 `gitAddress` 解析；`gitTag` 必须由请求显式提供，服务端不会回退到固定版本号。`gitTag`、`targetBranch` 和 `branch` 都只按字符串字段传递，不要求 SemVer、固定前缀或字符集，最终由 GitHub/Jenkins 判定是否可用。`targetBranch` 是 GitHub merge 目标，`branch` 是 Jenkins 构建分支；页面使用同一个“Git 分支”输入同步传入二者，直接 API 调用可按各自语义独立指定。

创建 Job 会按勾选任务执行真实外部操作；Git tag 以固定来源分支 `dev/master` 的当前 SHA 为快照，分支合并同样使用 `dev/master` 作为单一来源，并写入 `targetBranch`。`mode` 省略时默认为 `apply`；显式使用 `mode: "dry-run"` 时只跳过 GitHub tag/merge 写操作，但选中的 Jenkins package 仍会直接调用 Jenkins 接口。repository、ref、tag 和 SHA 不再由本地业务正则提前拒绝；GitHub 仍保留 host/HTTPS/同源、请求响应结构、写 gate 和 expected SHA 一致性约束。Idempotency-Key 不再校验字符格式，但 GitHub apply 写操作仍要求独立 gate 至少 16 个字符；缺失或过短的 gate 会在执行阶段返回 403/blocked，字段缺失或超过 DTO 长度边界仍返回 400，容量超限返回 429。成功返回 HTTP 202 和 `ResponseUtil.success` envelope。

相同 `Idempotency-Key + release unit + currentTag + payloadHash` 返回相同 Job（`idempotent=true`）；同一 Job ID 的 payload hash 不同返回 409。`runtime.ai` 从 Token 配置页面的 nested `ai` 对象传入，AI API Key 不写入进度文本、错误消息、Markdown 或日志；状态响应不会返回 `pageConfig` 或 runtime 中的凭据字段。

## 查询状态

```http
GET /api/release-automation/jobs/status?jobId=release-...
```

参数使用 `GetReleaseAutomationStatusDto`，成功返回 200 和 `ResponseUtil.success` envelope；字段仍需是字符串且不超过 DTO 长度边界，不再要求 `release-...` 的 Job ID 形状，未知或过期 ID 返回 404。Controller 只做 DTO 解析与 response wrapping，阶段成功以服务端 `progress.sequence` 为准，页面不得自行计算。

## 副作用执行边界

创建 Job 会按 `tasks` 执行真实 GitHub/Jenkins/modify-log 操作；发布 docs 任务只读收集提交、环境配置和 GitHub Contents 中的 modify-log 事实并生成 Markdown，不提交 GitHub 或 Feishu。modify-log 使用候选 SHA 或 `dev/master` 作为 ref，通过 GitHub Contents API 读取配置的仓库相对路径，并在 apply 模式将 SQL 原文归档；不会在服务端读取本地同名文件、执行 SQL 或清空 GitHub 源文件。任务使用幂等判断和必要的外部响应约束，冲突或来源 SHA 变化会阻断。AI 请求失败时使用本地事实摘要并将 `progress.degraded=true`，不编造内容。Feishu 文档写入仍未接通，选中后会在任何远程写操作前阻断。

## 发布 docs 输入与结果

发布 docs 不再接受手工 ref、时间窗口或环境/数据库开关。服务端从本次 `gitTag` 在 GitHub Tags API 返回顺序中定位当前 tag 和上一 tag，按两者 compare 结果收集提交；环境配置和 modify-log 事实固定读取。提交收集不传 `author`，也不按 person 筛选。

成功的 `data.progress.releaseDocs` 包含上一/当前 tag、两端 SHA、提交/合并提交统计、Markdown、checksum、`degraded` 和 warnings。AI 仅返回事实引用摘要，最终 Markdown 由服务端固定模板生成；公开响应不包含 AI API Key、原始 Prompt、完整模型响应或敏感环境值。

## 测试同步执行

```http
POST /api/release-automation/test/execute
Idempotency-Key: release-sync-test-001
Content-Type: application/json
```

该接口复用 `CreateReleaseAutomationJobDto`，但不创建 BullMQ Job、不读取或写入 Redis，适合本地/集成测试。未传 `mode` 时默认使用 `dry-run`；发布 docs 会自动解析当前/上一 tag 并通过 GitHub Contents 读取 ENV/modify-log，选中的 Jenkins package 在两种 mode 下都会直接调用 Jenkins。`modify-log` 在两种 mode 下都直接使用 GitHub 返回的 SQL 原文，apply 额外归档该原文；Feishu 仍会在远程写操作前阻断。

接口同步执行完成后返回 HTTP 200。HTTP 200 只表示同步执行已返回结果，业务是否成功以 `data.error` 和 `data.progress.stage` 判断；错误也会以 `data.error` 返回，不创建可通过 `/jobs/status` 查询的持久 Job。`Idempotency-Key` 仍是 apply 写操作所需的 gate，但同步接口不提供跨请求的持久幂等，重复 apply 可能再次执行外部步骤。
