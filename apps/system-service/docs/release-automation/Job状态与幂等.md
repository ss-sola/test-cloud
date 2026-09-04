# Job 状态、进度与幂等

## 状态

Job 使用 `planned`、`preflight_blocked`、`branch_plan_ready`、`candidate_prepared`、`jenkins_queued`、`jenkins_running`、`jenkins_trigger_unknown`、`jenkins_verified`、`docs_ready`、`feishu_failed`、`release_tag_created`、`modify_log_clear_pending`、`cleanup_pending`、`manual_intervention`、`completed`、`partial-success` 和 `failed` 状态集合。当前创建接口为 dry-run，默认执行 preflight/计划阶段；配置不足进入 `preflight_blocked`。

每次服务端阶段变化：

- `sequence` 单调递增；
- 写入 UTC `updatedAt`、阶段、百分比、message 和完整 release unit；
- Redis 中只保存脱敏 record；
- Job TTL 默认 60 分钟；Redis URL 缺失或 Redis 不可用时拒绝创建/查询 Job，绝不降级到进程内存，因此不会产生跨实例不一致的假持久化状态。

## 幂等

Job ID 由 `Idempotency-Key + repository + targetBranch + candidateSha + 1.9.0` 的 SHA-256 派生，不使用用户可注入路径。payload hash 对稳定排序 JSON 计算。重复请求在入队前和串行 admission gate 内各检查一次，处理并发竞态；hash 不同返回冲突。

## 恢复边界

Jenkins 触发响应丢失时必须通过已知的 origin、queue ID、build number、release unit 和 planHash reconcile，禁止盲目重复 POST。tag、Feishu、清空和远程 merge 均不由当前创建接口自动触发；源 checksum/generation 改变时清空停止并保留源文件。
