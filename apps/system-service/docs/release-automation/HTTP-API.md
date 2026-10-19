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
  "branch": "feature/release-v1",
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
  "environmentToSql": false,
  "modifyLogPath": ".version/modify-log.sql",
  "tasks": ["git-tag", "modify-log", "github-merge", "jenkins", "release-docs"]
}
```

`repository` 可省略并从 `gitAddress` 解析；`gitTag` 必须由请求显式提供。请求字段 `branch` 是当前/source 分支，用于创建 tag、写入发布 update-log 和作为 GitHub PR head；`targetBranch` 是 GitHub PR base，也是 PR 合并后 Jenkins 构建分支。两者可以不同。

`gitTag`、`targetBranch` 和 `branch` 都只按字符串字段传递，不要求 SemVer、固定前缀或字符集，最终由 GitHub/Jenkins 判定是否可用。请求字段缺失或超过 DTO 长度边界返回 400；容量超限返回 429。成功创建返回 HTTP 202 和 `ResponseUtil.success` envelope。

`environmentToSql` 是可选布尔值，缺省为 `false`。开启后，新增或变更的 env key 会生成 MySQL upsert，放在“各服务迁移环境变量”的 `env → sys_config` 代码块中，每条完整语句一行；不再附加单独的新增/减少/修改差异块。删除项与未变化项不生成 SQL。`description` 取变量定义前连续的整行 `#` 注释，去掉注释标记和首尾空白后以空格合并；空行会中断关联，行尾 `#` 仍是值的一部分；仅注释变化也会生成 upsert。关闭时，新增、减少、修改分别显示在三个独立代码块。类型按值推断，数字为 `number`、JSON 对象/数组为 `json`、其余为 `string`。SQL 和 description 会包含实际 ENV/注释值（可能含敏感信息）并提交至 GitHub；SQL 本身不进入 AI 提示，启用时 Job 状态不返回带 SQL 的 Markdown。

## 发布执行顺序

发布执行包含以下阶段：

| 步骤 | 任务 | 当前行为 |
| --- | --- | --- |
| 1 | Git tag | 从 `branch` 当前 ref 创建 tag；已存在 tag 时保持原 SHA 并复用 |
| 2 | modify-log SQL | 从候选 tag ref 读取 SQL，状态记为 `read`/`planned`；不执行、不写本地归档 |
| 3 | 发布 docs / update-log | 复用第 2 步的 SQL 事实生成 Markdown；apply 将 update-log 写入 `branch`，dry-run 只生成计划 |
| 4 | GitHub PR | 提交或复用 `branch -> targetBranch` 的 Pull Request，作为人工门禁 |
| 5 | Jenkins | PR 合并后的新 Job 使用 `targetBranch` 触发远程 Pipeline，并校验 Pipeline tag |
| 6 | Feishu 文档 | 当前未接通，选中时阻断，不伪造完成 |

首次 apply 在 tag 后先读取 modify-log，再生成并提交 update-log，之后创建或复用 PR。新 PR 会停在 `manual_intervention`；PR 冲突或提交失败时，modify-log 已读取，update-log 仍留在 `branch`，不会触发 Jenkins 或 Feishu。

PR 合并后重新创建 Job 时，服务端先读取 modify-log，再按 `branch`、`targetBranch` 和 release tag 查找唯一已合并 PR。找到后跳过重复的 Markdown 写入、PR 提交和人工门禁，继续 Jenkins（构建 `targetBranch`）及后续任务；未找到时按首次发布流程继续。

apply Job 的远程流程为：

1. 从 `branch` 当前 ref 读取或创建 Git tag，已存在时保持原 SHA；
2. 读取 candidate tag 对应的 modify-log SQL，保存 checksum、generation 和源 ref；不归档到本地，也不执行 SQL；
3. 查询当前 release tag 对应的已合并 PR；匹配时跳过重复 docs/PR 步骤并继续后置任务；
4. 未发现已合并 PR 时，将第 2 步读取的 SQL 复用到发布 Markdown，并把 update-log 写入 `branch`；dry-run 只生成计划，不执行写入；
5. 在 Markdown 写入完成后读取 `branch` 和 `targetBranch` refs，并校验 expected SHA；
6. 查询同仓库、同来源和同目标的 open Pull Request；唯一且来源 SHA 相同则复用，否则创建；
7. 新建或复用但尚未合并的 PR 进入 `manual_intervention`，返回 PR 编号和 URL，并结束本次 Job。

首次 Job 的 PR 门禁不会执行 Jenkins 或 Feishu，但 modify-log 已读取并纳入发布 Markdown。PR 合并后，新 Job 会通过已合并 PR 检查继续后置任务。
`mode: "dry-run"` 不发送 GitHub tag 或 Pull Request POST，仍可执行既有的只读预览步骤；选中的 Jenkins 任务是否调用 Jenkins 仍由该任务的现有配置和执行逻辑决定。真实 apply 不执行本地 `clone`、`pull`、`fetch`、`checkout`、merge 或本地构建。

## GitHub Pull Request、幂等与冲突

GitHub PR 适配器使用以下 API：

- `GET /repos/{owner}/{repo}/pulls?state=open&head={owner}:{branch}&base={targetBranch}`：查询可复用 PR；
- `GET /repos/{owner}/{repo}/pulls?state=closed&head={owner}:{branch}&base={targetBranch}`：查询 release tag 对应的已合并 PR；
- `POST /repos/{owner}/{repo}/pulls`：提交新 PR，body 包含 `title`、`head=branch`、`base=targetBranch` 和发布说明。

为避免重复提交：

- 多个匹配的 open PR 直接 fail closed，返回 `GITHUB_PR_FAILED`，不猜测要使用哪一个；
- 已有 PR 的 `headSha` 与本次 `branch` 当前 SHA 不一致时直接阻断，要求先在 GitHub 处理旧 PR；
- 创建返回 422 且响应明确包含“pull request already exists”时，重新查询一次同来源/目标 PR；若发现唯一且 SHA 一致的 PR 则视为并发创建后的复用，否则保留失败；其他 422 校验错误不查询、不误复用；
- 创建响应的 `headSha` 与读取到的 source SHA 不一致时阻断，要求重新 plan。

GitHub 的 merge conflict 不通过 API 自动解决。PR 可以提交但可能显示 `mergeable=false` 或 `mergeableState=dirty`；此时 GitHub 任务标记为 `blocked`，Job 仍停在 `manual_intervention`，不会触发后续发布。维护人员在 GitHub 分支保护、冲突编辑器或授权开发分支中解决冲突并完成审核；合并完成后重新发起完整发布 Job。`mergeable=null` 或 `mergeableState=unknown` 只表示 GitHub 尚未完成判断，不得误标记为冲突，但同样不会跳过人工 PR 门禁。

相同 `Idempotency-Key + release unit + currentTag + payloadHash` 返回相同 Job（`idempotent=true`）；同一 Job ID 的 payload hash 不同返回 409。状态响应不会返回 `pageConfig` 或 runtime 中的凭据字段，token 不写入进度、日志、PR 信息或 localStorage 草稿。

## 查询状态

```http
GET /api/release-automation/jobs/status?jobId=release-...
```

参数使用 `GetReleaseAutomationStatusDto`。成功返回 200 和 `ResponseUtil.success` envelope；未知或过期 ID 返回 404。状态以服务端 `progress.sequence` 为准，页面不得自行计算。PR 信息位于 `data.progress.pullRequest`：包括编号、URL、标题、来源/目标分支、来源 SHA、GitHub 返回的 `mergeable`/`mergeableState` 和 merged 时间 `mergedAt`。

## 后置副作用边界

首次 apply 将发布 Markdown 和 update-log 提交到 `branch`，并创建/复用 `branch -> targetBranch` PR；`targetBranch` 仅在 PR 合并后用于 Jenkins 构建。合并后新建 Job 会查询对应 release tag 的 closed PR；唯一匹配且 `merged_at` 非空时跳过重复 docs/PR，继续 Jenkins、modify-log 和 Feishu。发布 docs 从 tag 间提交、脱敏环境差异和 GitHub Contents 中的 modify-log 原文收集事实；不会读取本地同名文件、执行 SQL 或通过本地文件归档业务状态。

## 测试同步执行

```http
POST /api/release-automation/test/execute
Idempotency-Key: release-sync-test-001
Content-Type: application/json
```

该接口复用 `CreateReleaseAutomationJobDto`，但不创建 BullMQ Job、不读取或写入 Redis。未传 `mode` 时默认使用 `dry-run`；dry-run 不发起 GitHub PR POST。同步接口显式传 `mode: "apply"` 时仍遵守 PR 提交后 `manual_intervention` 终态和后置步骤门禁；它不提供跨请求的持久幂等，重复 apply 可能再次执行外部只读/写入步骤。
