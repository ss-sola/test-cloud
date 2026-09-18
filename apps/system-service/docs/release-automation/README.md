# 发布自动化

本模块为输入 `gitTag` 的发布单元提供真实执行能力和受控适配器。发布单元由以下字段组成：

```text
repository + targetBranch + gitTag
```

发布单元字段是字符串协议值：`gitTag` 不要求 SemVer 或固定字符集，repository、targetBranch、branch、ref 和 SHA 不执行本地业务格式校验，最终由 GitHub/Jenkins 判定是否可用。服务仍保留 GitHub host/HTTPS/同源、写 gate、响应结构、动态 queue/build ID 及 SQL 转义等传输和副作用安全边界。

## 文档导航

- [配置与安全边界](./配置与安全边界.md)
- [HTTP API](./HTTP-API.md)
- [Job 状态、进度与幂等](./Job状态与幂等.md)
- [modify-log SQL 与清空门](./modify-log-SQL与清空门.md)
- [Jenkins 与 GitHub 适配器](./外部适配器.md)

## 当前交付范围

- GitHub Contents、commits、tags、branches、refs、compare、merge 和 tag API client；发布文档收集当前 tag 与 GitHub 返回的上一 tag 之间的提交，不按 person/author 筛选。
- 发布 docs 任务生成确定性 Markdown；AI 使用 Token 配置中的 nested `ai`，仅输出带事实引用的摘要，AI 不可用时降级为本地摘要，并通过 Job 结果返回。
- `modify-log.sql` 受控读取、确定性 SQL、SHA-256、原子归档和 compare-and-clear；本次发布 docs 只读取/渲染数据库事实，不自动清空或提交外部数据库。
- Jenkins queue/build/text 轮询与 Pipeline tag 解析，全部使用本次动态 queue/build 编号。
- 真实执行 Job、Redis 缺失时拒绝入队、独立 Redis prefix、服务端 sequence 进度和幂等冲突检测。dry-run/apply 由 Job 的 mode 决定；apply 仍需独立 gate。默认支持 Git tag、GitHub merge、Jenkins、release docs 和 modify-log 归档；Feishu 任务未配置目标时在远程写操作前阻断。
- 提供测试用同步执行入口 `POST /api/release-automation/test/execute`；默认 dry-run、不创建 BullMQ Job，不能替代生产 Job 的持久化与跨请求幂等流程。

## 当前限制

本模块不会执行本地 Git merge、clone、pull、fetch、checkout 或 worktree；远程分支操作全部通过 GitHub API。发布 Markdown 本次只生成并返回，不提交 GitHub 或 Feishu；AI API 失败时使用本地摘要，不伪造事实。modify-log 已支持读取、确定性渲染和 apply 归档，但不会自动清空源文件；Feishu 文档写入仍需后续独立契约。
