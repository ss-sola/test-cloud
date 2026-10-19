# 发布自动化架构边界

`system-service` 的 release-automation 由自动注册扫描 `@Injectable` 和 `@Controller`，不新增业务 Module。Controller 提供持久化 Job、状态查询和测试同步执行三类入口；同步入口只在请求内存中运行，不创建 Redis/BullMQ Job。业务编排位于 `ReleaseAutomationService`/`ReleaseAutomationExecutionService`，外部访问位于 `GitHubReleaseClientService`/`JenkinsClientService`。

## 分支语义

- `branch`：当前/source 分支，tag 和 update-log 在该分支，GitHub PR head 使用该分支；
- `targetBranch`：GitHub PR base 分支，也是 PR 合并后 Jenkins 构建分支；
- PR 未合并前，不允许继续 Jenkins、Feishu 或 completed；modify-log 已在 PR 前读取并纳入发布 Markdown；
- PR 合并后新 Job 自动识别当前 release tag 的已合并 PR，跳过重复 docs/PR 门禁并继续后置步骤。

## 外部副作用矩阵

| 能力 | dry-run | apply |
| --- | --- | --- |
| GitHub metadata/ref/PR 查询 | 受控只读 | allowlist 只读 |
| GitHub tag POST | 不调用 | 独立 gate，已存在则跳过 |
| modify-log SQL 读取 | 受控只读 | tag 后读取 GitHub Contents，由发布 docs 复用 |
| update-log Markdown 写入 | 仅生成计划，不调用 GitHub 写接口 | 无历史时通过 Contents 首次写入；后续仅替换 current branch tip 上可确认的自动 update-log commit |
| GitHub Pull Request POST | 不调用 | 独立 gate；可复用唯一 open PR |
| PR 未合并后的 Jenkins/Feishu | 不适用 | 不执行，Job 进入 `manual_intervention` |
| PR 合并后的后置步骤 | 需重新 Job | 新 Job 按选择执行 |
| 本地 Git/第三方代码构建 | 禁止 | 禁止 |
| Redis Job | 测试同步入口不创建 | 仅短期队列状态，带 TTL |

## 六步流程与冲突恢复边界

发布流程包含 Git tag、modify-log SQL 读取、发布 docs/update-log、GitHub PR、Jenkins Pipeline 和 Feishu 文档 6 项任务。`branch` 是 current/source，tag 与 update-log 在该分支创建，PR head 使用该分支；`targetBranch` 是 PR base 和 Jenkins 构建分支。首次 apply 在 tag 后读取 modify-log，并由 docs 使用同一份 SQL 生成 Markdown；没有 update-log 历史时通过 Contents API 首次写入。后续 apply 仅当该路径最新的自动 update-log commit 仍是 `branch` HEAD 时，使用 Git Data 创建以旧 commit parent 为 parent 的替代 commit，再强制更新 source ref；仅替换 tip 一条，人工提交、HEAD 前进或不可验证的历史均 fail closed。`targetBranch` 仍只通过 PR 接收这些变更。PR 合并后新 Job 重新读取 modify-log，按 current branch、target branch 和 release tag 自动识别唯一已合并 PR，跳过重复 docs/PR 步骤并继续 Jenkins。dry-run 只生成计划，不写 Contents 或 Git Data。PR 冲突或提交失败不会回滚 current branch 上的 update-log。

服务端不下载第三方代码、不执行本地三方 merge，也不强制覆盖 `targetBranch`；唯一的 branch history rewrite 是在 `currentBranch` HEAD 仍为可确认的自动 update-log commit 时，以 parent 为基底创建 replacement commit 并 force-update source ref。最终 HEAD 检查无法消除检查与 ref PATCH 之间的并发 push 竞态；branch protection 拒绝时 fail closed，不绕过保护。GitHub PR 创建成功但返回 `mergeable=false` 或 `mergeableState=dirty` 时，保留 PR URL，将 GitHub 任务标记为 `blocked` 并停在 `manual_intervention`，由授权人员在 GitHub 解决并合并；`mergeable=null` 或 `mergeableState=unknown` 不误判为冲突，但也不会绕过人工门禁。查询到多个匹配 PR、来源 SHA 漂移或非“已有 PR”类 422 时 fail closed。整个流程不修改 `common-service`、数据库 schema 或权限种子，也不执行真实 GitHub、Jenkins、Feishu 或数据库请求。
