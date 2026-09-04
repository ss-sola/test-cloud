# 发布自动化

本模块为 `1.9.0` 发布单元提供可测试的 dry-run 计划能力和受控适配器。发布单元由以下不可变字段组成：

```text
repository + targetBranch + candidateSha + version(固定 1.9.0)
```

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
- 默认 dry-run Job、Redis 缺失时拒绝入队、独立 Redis prefix、服务端 sequence 进度和幂等冲突检测。

## 明确不做

本模块不会执行本地 Git merge、clone、pull、fetch、checkout 或 worktree，不默认创建远程 merge/tag，不执行 SQL，不清空 modify-log，不调用真实 Jenkins/Feishu/数据库。创建 Job 的 HTTP 接口只允许 dry-run；apply、tag、Jenkins POST 和 clear 由独立 gate 方法保护。
