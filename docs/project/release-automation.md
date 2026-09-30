# 发布自动化架构边界

`system-service` 的 release-automation 由自动注册扫描 `@Injectable` 和 `@Controller`，不新增业务 Module。Controller 提供持久化 Job、状态查询和测试同步执行三类入口；同步入口只在请求内存中运行，不创建 Redis/BullMQ Job。业务编排位于 `ReleaseAutomationService`/`ReleaseAutomationExecutionService`，外部访问位于 `GitHubReleaseClientService`/`JenkinsClientService`。

## 分支语义

- `branch`：Jenkins 构建分支；
- `targetBranch`：GitHub Pull Request base 分支；
- `dev/master`：GitHub Pull Request head，固定来源；
- PR 未提交/未合并前，不允许继续 Jenkins、modify-log、Feishu 或 completed。

## 外部副作用矩阵

| 能力 | dry-run | apply |
| --- | --- | --- |
| GitHub metadata/ref/PR 查询 | 受控只读 | allowlist 只读 |
| GitHub tag POST | 不调用 | 独立 gate，已存在则跳过 |
| GitHub Pull Request POST | 不调用 | 独立 gate；可复用唯一 open PR |
| PR 未合并后的 Jenkins/modify-log/Feishu | 不适用 | 不执行，Job 进入 `manual_intervention` |
| PR 合并后的后置步骤 | 需重新 Job | 新 Job 按选择执行 |
| 本地 Git/第三方代码构建 | 禁止 | 禁止 |
| Redis Job | 测试同步入口不创建 | 仅短期队列状态，带 TTL |

## 五步流程与冲突恢复边界

页面把发布拆为 Git tag、GitHub PR、Jenkins Pipeline、modify-log SQL 和 Feishu 文档 5 项任务。由于 PR 是远程人工门禁，第一次 apply 只提交/复用 PR 并进入 `manual_intervention`；PR 合并后重新发起 Job，才允许继续 Jenkins、modify-log 和 Feishu。

服务端不下载第三方代码、不执行本地三方 merge、不强制覆盖目标分支。GitHub PR 创建成功但返回 `mergeable=false` 或 `mergeableState=dirty` 时，保留 PR URL，将 GitHub 任务标记为 `blocked` 并停在 `manual_intervention`，由授权人员在 GitHub 解决并合并；`mergeable=null` 或 `mergeableState=unknown` 不误判为冲突，但也不会绕过人工门禁。查询到多个匹配 PR、来源 SHA 漂移或非“已有 PR”类 422 时 fail closed。整个流程不修改 `common-service`、数据库 schema 或权限种子，也不执行真实 GitHub、Jenkins、Feishu 或数据库请求。
