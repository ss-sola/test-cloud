# Job 状态、进度与幂等

## 状态

Job 使用 `planned`、`preflight_blocked`、`branch_plan_ready`、`candidate_prepared`、`jenkins_queued`、`jenkins_running`、`jenkins_verified`、`docs_ready`、`modify_log_read`、`manual_intervention`、`completed`、`partial-success` 和 `failed` 状态集合。

首次 apply 在 tag 后读取 modify-log SQL，并将该快照用于生成 update-log；新建或复用但未合并的 PR 随后进入 `manual_intervention`。此时 modify-log 已读取并纳入 Markdown，只有 Jenkins 与 Feishu 仍等待 PR 合并：

- `progress.pullRequest` 保存编号、URL、标题、来源/目标分支、source SHA、`mergeable`、`mergeableState` 和 merged 时间；
- `progress.modifyLog.status` 为 `read`（dry-run 为 `planned`），不代表本地归档或清空；
- 新 Job 先重新读取 modify-log，再查询 current→target 的 closed PR；唯一且 release tag/title 匹配、`merged_at` 非空时，跳过重复 docs/PR 和人工门禁，继续 Jenkins 与后置步骤；
- Jenkins 使用 `targetBranch`，不是 current/source branch；
- 明确 `mergeable=false` 或 `mergeableState=dirty` 时，GitHub 任务为 `blocked`，Job 仍停在 `manual_intervention`，由人工解决冲突；
- `mergeable=null` 或 `mergeableState=unknown` 不标记冲突；多个重复 open PR、重复匹配的 merged PR 或来源 SHA 漂移均 fail closed。

每次服务端阶段变化写入 UTC `updatedAt`、阶段、百分比、单调 `sequence`、完整 release unit（包括 current 与 target branch）和有界日志。页面遇到 `manual_intervention`、`completed`、`failed` 或 `preflight_blocked` 时停止轮询，并展示人工操作提示和 PR URL。

## PR 幂等与并发

相同 current/target 的 PR 按发布版本处理：

1. 查询 `branch -> targetBranch` 的 open PR；
2. 唯一且 `headSha` 等于 current branch 快照时复用；
3. 无 open PR 时创建；
4. 只有创建响应明确包含“pull request already exists”时才重新查询一次；其他 422 直接失败；
5. 合并后的重跑查询 `state=closed`，仅唯一匹配同一 release tag、current/target 和 `merged_at` 的 PR 可绕过人工门禁；
6. 多个匹配或 SHA 不一致直接失败，等待人工清理/重新 plan。

幂等 payload 包含 `currentBranch` 和 `targetBranch`，同一幂等键不能将来源分支静默改成另一个 release unit。

该策略把 GitHub 的 merge conflict 留在 PR 审核流程中，避免服务端下载代码、执行本地三方合并或覆盖目标分支。

## 其它恢复边界

Git tag 从 current branch 当前 SHA 创建并保持不可变；已存在时复用。Jenkins 触发响应丢失时只能通过已知 queue/build 信息 reconcile，禁止盲目重复 POST。Feishu、清空和其它未配置阶段保持 blocked/skipped，不伪造完成。
