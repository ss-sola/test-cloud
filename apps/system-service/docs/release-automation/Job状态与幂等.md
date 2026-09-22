# Job 状态、进度与幂等

## 状态

Job 使用 `planned`、`preflight_blocked`、`branch_plan_ready`、`candidate_prepared`、`jenkins_queued`、`jenkins_running`、`jenkins_verified`、`docs_ready`、`modify_log_clear_pending`、`manual_intervention`、`completed`、`partial-success` 和 `failed` 状态集合。

apply 任务在 GitHub PR 提交或复用成功后进入 `manual_intervention`。这是本次 Job 的终态，不是可自动恢复的暂停点：

- `progress.pullRequest` 保存编号、URL、标题、来源/目标分支、source SHA、`mergeable` 和 `mergeableState`；
- 不再执行 Jenkins、modify-log、Feishu 或 `completed`；
- PR 合并后旧 Job 不会自动继续，必须重新发起完整发布 Job；
- 明确 `mergeable=false` 或 `mergeableState=dirty` 时，GitHub 任务为 `blocked`，Job 仍停在 `manual_intervention`，由人工解决冲突；
- `mergeable=null` 或 `mergeableState=unknown` 不标记冲突；多个重复 PR、来源 SHA 漂移仍 fail closed，不自动选择、不强制覆盖。

每次服务端阶段变化写入 UTC `updatedAt`、阶段、百分比、单调 `sequence`、完整 release unit 和有界日志。页面遇到 `manual_intervention`、`completed`、`failed` 或 `preflight_blocked` 时停止轮询，并展示人工操作提示和 PR URL。

## PR 幂等与并发

相同来源/目标的 open PR 只允许唯一匹配：

1. 查询 `dev/master -> targetBranch` 的 open PR；
2. 唯一且 `headSha` 等于本次 source SHA 时复用；
3. 无匹配时创建；
4. 只有创建响应明确包含“pull request already exists”时才重新查询一次；其他 422 直接失败；
5. 多个匹配或 SHA 不一致直接失败，等待人工清理/重新 plan。

该策略把 GitHub 的 merge conflict 留在 PR 审核流程中，避免服务端下载代码、执行本地三方合并或覆盖目标分支。

## 其它恢复边界

Git tag 创建前后仍以固定来源分支 `dev/master` 的 SHA 快照执行幂等检查；tag 422 只允许重新读取一次并在远程响应可消费时视为幂等成功。Jenkins 触发响应丢失时只能通过已知 queue/build 信息 reconcile，禁止盲目重复 POST。Feishu、清空和其它未配置阶段保持 blocked/skipped，不伪造完成。
