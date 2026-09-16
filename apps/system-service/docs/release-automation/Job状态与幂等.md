# Job 状态、进度与幂等

## 状态

Job 使用 `planned`、`preflight_blocked`、`branch_plan_ready`、`candidate_prepared`、`jenkins_queued`、`jenkins_running`、`jenkins_trigger_unknown`、`jenkins_verified`、`docs_ready`、`feishu_failed`、`release_tag_created`、`modify_log_clear_pending`、`cleanup_pending`、`manual_intervention`、`completed`、`partial-success` 和 `failed` 状态集合。`dry-run`/`apply` 由 Job 的 mode 决定；`apply` 仍必须满足独立写 gate、凭据和外部响应/SQL 安全约束，配置不足或 SHA 变化进入 `preflight_blocked`/`partial-success`。Git tag、repository、ref 和 SHA 不再执行本地业务格式校验。

每次服务端阶段变化：

- 写入 UTC `updatedAt`、阶段、百分比、message、单调 `sequence`、完整 release unit 和有界的全量 `logs`；
- Redis 中只保存脱敏 record；
- Job TTL 默认 60 分钟；Redis URL 缺失或 Redis 不可用时拒绝创建/查询 Job，绝不降级到进程内存，因此不会产生跨实例不一致的假持久化状态。

创建请求可通过 `tasks` 指定六个执行步骤：`git-tag`、`github-merge`、`jenkins`、`release-docs`、`modify-log`、`feishu`；未传时默认全部勾选。取消勾选的步骤会在服务端任务状态中标记为 `skipped`，不会调用对应副作用接口。

Job ID 仍由规范化后的 Idempotency-Key SHA-256 派生，不使用用户原值作为 Redis/BullMQ ID；状态查询不再要求 `release-[A-Za-z0-9-]{8,80}` 形状，未知 ID 由队列查询后返回 404。Idempotency-Key 本身不再校验字符格式，但 GitHub apply 写操作仍要求 gate 至少 16 个字符。payload hash 对稳定排序 JSON 计算。重复请求在入队前和串行 admission gate 内各检查一次，处理并发竞态；hash 不同返回冲突。

## 恢复边界

Jenkins 触发响应丢失时必须通过已知的 origin、queue ID、build number、release unit 和 planHash reconcile，禁止盲目重复 POST。Git tag 创建前后仍以固定来源分支 `dev/master` 的 SHA 快照执行幂等检查；tag 422 只允许重新读取一次并在远程响应可消费时视为幂等成功。远程 merge 使用 `dev/master` 单一来源分支，写前后校验页面选定目标分支与 source SHA；冲突或 SHA 漂移停止后续写操作。Feishu、清空和其它未配置阶段仍保持 blocked/skipped，不伪造完成。
