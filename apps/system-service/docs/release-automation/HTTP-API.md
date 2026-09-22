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
  "branch": "release/v1",
  "targetBranch": "release/v1",
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

`repository` 可省略并从 `gitAddress` 解析；`gitTag` 必须由请求显式提供。`targetBranch` 是 GitHub Pull Request 的目标（base）分支，`branch` 只作为 Jenkins 构建分支参数，两者可以不同。GitHub Pull Request 的来源固定为 `dev/master`，页面不会再用 Jenkins 分支代替 PR 目标。

`gitTag`、`targetBranch` 和 `branch` 都只按字符串字段传递，不要求 SemVer、固定前缀或字符集，最终由 GitHub/Jenkins 判定是否可用。请求字段缺失或超过 DTO 长度边界返回 400；容量超限返回 429。成功创建返回 HTTP 202 和 `ResponseUtil.success` envelope。

## 发布执行顺序

页面将发布拆成 5 项任务：

| 步骤 | 任务 | 当前行为 |
| --- | --- | --- |
| 1 | Git tag | 读取或创建固定来源 `dev/master` 的 tag，已存在则跳过 |
| 2 | GitHub PR | 提交或复用 `dev/master -> targetBranch` 的 Pull Request，作为人工门禁 |
| 3 | Jenkins | PR 合并后由新的发布 Job 触发远程 Pipeline，并校验 Pipeline tag |
| 4 | modify-log SQL | PR 合并后由新的发布 Job 读取并按 apply 规则归档原文 |
| 5 | Feishu 文档 | 当前未接通，选中时阻断，不伪造完成 |

第一次 apply 执行到第 2 步会停在 `manual_intervention`；只有 PR 在 GitHub 完成审核和合并后，才重新创建 Job 执行第 3 至第 5 步。

apply Job 的远程流程为：

1. 读取或创建固定来源 `dev/master` 的 Git tag，已存在时跳过创建；
2. 读取 `dev/master` 和 `targetBranch` 的当前 ref，校验 plan 阶段的 expected SHA；
3. 查询同仓库、同来源和同目标的 open Pull Request；唯一且来源 SHA 相同则复用，否则创建 Pull Request；
4. Pull Request 成功提交或复用后，将 Job 写入 `manual_intervention`，返回 PR 编号和 URL，并立即结束本次 Job。

第 4 步是本次 Job 的终态，不会继续调用 Jenkins、modify-log、Feishu，也不会写入 `completed`。PR 合并后不会自动恢复旧 Job；需要重新创建一份完整发布 Job，由新的 Job 重新校验 tag、分支 SHA 并执行后续步骤。

`mode: "dry-run"` 不发送 GitHub tag 或 Pull Request POST，仍可执行既有的只读预览步骤；选中的 Jenkins 任务是否调用 Jenkins 仍由该任务的现有配置和执行逻辑决定。真实 apply 不执行本地 `clone`、`pull`、`fetch`、`checkout`、merge 或本地构建。

## GitHub Pull Request、幂等与冲突

GitHub PR 适配器使用以下 API：

- `GET /repos/{owner}/{repo}/pulls?state=open&head={owner}:dev/master&base={targetBranch}`：查询可复用 PR；
- `POST /repos/{owner}/{repo}/pulls`：提交新 PR，body 包含 `title`、`head=dev/master`、`base=targetBranch` 和发布说明。

为避免重复提交：

- 多个匹配的 open PR 直接 fail closed，返回 `GITHUB_PR_FAILED`，不猜测要使用哪一个；
- 已有 PR 的 `headSha` 与本次 `dev/master` SHA 不一致时直接阻断，要求先在 GitHub 处理旧 PR；
- 创建返回 422 且响应明确包含“pull request already exists”时，重新查询一次同来源/目标 PR；若发现唯一且 SHA 一致的 PR 则视为并发创建后的复用，否则保留失败；其他 422 校验错误不查询、不误复用；
- 创建响应的 `headSha` 与读取到的 source SHA 不一致时阻断，要求重新 plan。

GitHub 的 merge conflict 不通过 API 自动解决。PR 可以提交但可能显示 `mergeable=false` 或 `mergeableState=dirty`；此时 GitHub 任务标记为 `blocked`，Job 仍停在 `manual_intervention`，不会触发后续发布。维护人员在 GitHub 分支保护、冲突编辑器或授权开发分支中解决冲突并完成审核；合并完成后重新发起完整发布 Job。`mergeable=null` 或 `mergeableState=unknown` 只表示 GitHub 尚未完成判断，不得误标记为冲突，但同样不会跳过人工 PR 门禁。

相同 `Idempotency-Key + release unit + currentTag + payloadHash` 返回相同 Job（`idempotent=true`）；同一 Job ID 的 payload hash 不同返回 409。状态响应不会返回 `pageConfig` 或 runtime 中的凭据字段，token 不写入进度、日志、PR 信息或 localStorage 草稿。

## 查询状态

```http
GET /api/release-automation/jobs/status?jobId=release-...
```

参数使用 `GetReleaseAutomationStatusDto`。成功返回 200 和 `ResponseUtil.success` envelope；未知或过期 ID 返回 404。状态以服务端 `progress.sequence` 为准，页面不得自行计算。PR 信息位于 `data.progress.pullRequest`：包括编号、URL、标题、来源/目标分支、来源 SHA 以及 GitHub 返回的 `mergeable` 和 `mergeableState` 状态。

## 后置副作用边界

只有重新发起并通过 PR 阶段的新 Job，才会继续执行 Jenkins、modify-log、release docs 和 Feishu 任务。发布 docs 只读收集提交、脱敏环境差异和 GitHub Contents 中的 modify-log 原文并生成 Markdown；apply 模式按既有规则写入 update-log。不会在服务端读取本地同名文件、执行 SQL 或通过本地文件归档业务状态。Feishu 文档写入仍未接通，选中后会在远程写操作前阻断。

## 测试同步执行

```http
POST /api/release-automation/test/execute
Idempotency-Key: release-sync-test-001
Content-Type: application/json
```

该接口复用 `CreateReleaseAutomationJobDto`，但不创建 BullMQ Job、不读取或写入 Redis。未传 `mode` 时默认使用 `dry-run`；dry-run 不发起 GitHub PR POST。同步接口显式传 `mode: "apply"` 时仍遵守 PR 提交后 `manual_intervention` 终态和后置步骤门禁；它不提供跨请求的持久幂等，重复 apply 可能再次执行外部只读/写入步骤。
