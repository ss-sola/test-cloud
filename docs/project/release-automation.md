# 发布自动化架构边界

`system-service` 的 release-automation 由自动注册扫描 `@Injectable` 和 `@Controller`，不新增业务 Module。Controller 提供持久化 Job、状态查询和测试同步执行三类入口；同步入口只在请求内存中运行，不创建 Redis/BullMQ Job。业务编排位于 `ReleaseAutomationService`/`ReleaseAutomationExecutionService`，外部访问位于 `GitHubReleaseClientService`/`JenkinsClientService`，纯转换位于 ENV diff 与 SQL renderer。

外部副作用矩阵：

| 能力 | dry-run | apply |
| --- | --- | --- |
| GitHub metadata | fake/受控只读 | allowlist 只读 |
| GitHub merge/tag | 不调用 | 独立 gate |
| Jenkins POST | 不调用 | credential + 独立 gate |
| SQL artifact/archive | 只内存 | 原子归档 |
| modify-log clear | 永远不调用 | 独立 token + compare-and-clear |
| Redis Job | 缺少 Redis 时拒绝创建/查询 | 独立 prefix 持久化 |

本次不修改 common-service、权限种子、数据库 schema、现有 weekly-report/config-preview/BullMQ dashboard 逻辑，不执行真实 GitHub、Jenkins、Feishu 或数据库请求。
