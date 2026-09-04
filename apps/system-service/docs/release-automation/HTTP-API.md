# HTTP API

## 创建 dry-run Job

```http
POST /api/release-automation/jobs
Idempotency-Key: release-20260904-001
Content-Type: application/json
```

请求 body 使用 `CreateReleaseAutomationJobDto`：

```json
{
  "repository": "acme/project",
  "targetBranch": "custom/prod",
  "candidateSha": "40 位 hex SHA",
  "version": "1.9.0",
  "mode": "dry-run"
}
```

`repository` 可省略但 allowlist 必须只有一个目标；`version` 只接受 `1.9.0`；`mode` 只接受 `dry-run`。缺失/非法 Idempotency-Key、分支、SHA 或 allowlist 返回 400/403；`mode=apply` 返回 403；容量超限返回 429。成功返回 HTTP 202 和 `ResponseUtil.success` envelope。

相同 `Idempotency-Key + release unit + payloadHash` 返回相同 Job（`idempotent=true`）；同一 Job ID 的 payload hash 不同返回 409。请求不会把 secret 放入 Job。

## 查询状态

```http
GET /api/release-automation/jobs/status?jobId=release-...
```

参数使用 `GetReleaseAutomationStatusDto`，成功返回 200 和 `ResponseUtil.success` envelope；格式非法返回 400，不存在/过期返回 404。Controller 只做 DTO 解析与 response wrapping，阶段成功以服务端 `progress.sequence` 为准，页面不得自行计算。

## 暂不暴露的副作用接口

本次没有暴露 merge、Jenkins POST、创建 tag、Feishu publish 或 modify-log clear HTTP 接口。对应 service 方法必须携带 `mode=apply` 和独立 gate；不能用创建 Job 请求体的布尔字段绕过。ApiFox 后续应以本文件的两个只读/排队接口为契约，并在启用 apply 前单独登记权限、CSRF 和管理网段策略。
