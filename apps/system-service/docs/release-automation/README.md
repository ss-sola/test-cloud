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

- ENV 纯函数差异：`added`、`removed`、`changed`、`unchanged`，敏感 key 只输出统一掩码。
- GitHub Contents、commits、branches、refs、compare、merge 和 tag API client；分支合并只表达远程 API 调用，不下载代码。
- `modify-log.sql` 受控读取、确定性 SQL、SHA-256、原子归档和 compare-and-clear。
- Jenkins queue/build/text 轮询与 Pipeline tag 解析，全部使用本次动态 queue/build 编号。
- 真实执行 Job、Redis 缺失时拒绝入队、独立 Redis prefix、服务端 sequence 进度和幂等冲突检测。dry-run/apply 由 Job 的 mode 决定；apply 仍需独立 gate。Feishu 当前按要求跳过。
- 提供测试用同步执行入口 `POST /api/release-automation/test/execute`；默认 dry-run、不创建 BullMQ Job，不能替代生产 Job 的持久化与跨请求幂等流程。

## 当前限制

本模块不会执行本地 Git merge、clone、pull、fetch、checkout 或 worktree；远程分支操作全部通过 GitHub API。Feishu 当前不执行，modify-log database tree commit 和 AI Markdown 需要对应外部配置；未配置时任务进入 blocked，不伪造成功。
