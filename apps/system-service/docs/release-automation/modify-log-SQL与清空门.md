# modify-log SQL 与归档边界

`ModifyLogGatewayService` 通过 GitHub Contents API 读取发布 ref 中的仓库相对路径，页面默认路径为 `.version/modify-log.sql`。服务端不从 `process.cwd()`、本地工作区或同名本地文件读取。

发布 Job 在 tag 后、docs/PR 前从 candidate tag ref 读取 modify-log SQL；同一份读取结果直接供发布 Markdown 使用，不重复读取。该步骤只准备 GitHub 原文和来源 checksum，`artifact` 为 `null`，不会执行 SQL、写入服务器归档或清空源文件。PR 未合并时 Jenkins/Feishu 仍被人工门禁阻止，但 SQL 已读取并随 update-log 进入 PR；合并后新 Job 会重新读取当前 release tag 对应 SQL，再自动识别已合并 PR 并继续后置步骤。

## GitHub 更新日志

更新日志写入当前/source `branch` 并随 PR 合并到 `targetBranch`：

```text
update-log/{previousTag}-{currentTag}.md
```

首次 apply 会将 update-log 写入当前/source `branch`。后续 apply 会检查该路径的最新提交和 `branch` HEAD：新自动提交 marker 绑定路径和原始 tag 对；旧版提交仅在 message 精确匹配 `docs: update log {previous} -> {current}`、Markdown 标题与请求 tag 对一致、单父提交且只修改该文件时兼容识别。只有该自动提交仍是 `branch` HEAD、当前 blob SHA 与提交文件一致时才替换；人工提交、tag 归一化冲突、其它路径提交导致 HEAD 前进、包含其它文件或无法确认时 fail closed。

替换时，Git Data API 基于原提交 parent 的 tree 写入新的 Markdown blob，创建以该 parent 为唯一 parent 的 replacement commit，再将 `refs/heads/{branch}` force-update 到新提交。旧提交会从该分支可达历史中移除，但不会立即删除 Git 对象；每次新 apply 只替换最新一条，较早的重复提交仍保留。相同幂等 run marker 重试返回 `unchanged`；不同 apply 即使 Markdown 内容相同也生成新的 replacement commit。所有写操作需要 apply gate；dry-run 不创建 Git Data 对象或更新 ref。branch protection 拒绝或最终 HEAD 检查发现漂移时阻断，不绕过保护。最终 HEAD 检查与 PATCH 之间仍存在并发 push 竞态。

可选的 env → `sys_config` 转换会把新增或变更变量的写入 SQL 放在 update-log 的“各服务迁移环境变量”段落中，每条完整语句占一行；启用 SQL 时不再附加新增/减少/修改差异块。未启用 SQL 时，三类 env 差异分别展示在三个代码块中。`description` 取变量定义前连续的整行 `#` 注释，去掉注释标记和首尾空白后以空格合并；空行会中断关联，行尾 `#` 仍属于值，注释变化也会生成 description upsert。删除项与未变化项不生成 SQL。SQL 仅包含 `key`、`value`、`type`、`description` 配置数据，不包含建表语句或时间戳列；ENV 值和注释可能含敏感信息并以明文进入 GitHub update-log。该转换仅生成 SQL，不执行 SQL；原 modify-log 仍按原文读取并原样纳入发布说明。

## 清空边界

当前发布流程不执行本地清空，也不调用 GitHub 写接口删除或截断源文件。GitHub 来源的 modify-log 只能被读取并纳入发布事实；旧的 compare-and-clear 兼容接口仍会拒绝 GitHub 来源，避免误操作远程仓库文件。
