# modify-log SQL 与归档边界

`ModifyLogGatewayService` 通过 GitHub Contents API 读取发布 ref 中的仓库相对路径，页面默认路径为 `.version/modify-log.sql`。服务端不从 `process.cwd()`、本地工作区或同名本地文件读取。

apply 流程只有在新的 Job 完成 GitHub PR 阶段后才会进入 modify-log；PR 未合并的 Job 不读取、不归档、不清空 SQL。读取到的 SQL 原文参与发布 Markdown 事实，服务端不解析、不执行 SQL，也不以本地文件保存业务状态。

## GitHub 更新日志

更新日志写入当前发布的 `targetBranch`：

```text
update-log/{previousTag}-{currentTag}.md
```

同名文件内容 checksum 未变化时返回 `unchanged`，内容变化时携带现有 GitHub 文件 SHA 更新。dry-run 只生成预览，不发起 GitHub PUT；GitHub 409/422 冲突会阻断 release-docs。

可选的 env → `sys_config` 转换会把新增或变更变量的写入 SQL 附在同一 Markdown 的“各服务迁移 SQL”段落中；删除项与未变化项不生成语句。SQL 仅包含 `key`、`value`、`type`、`description` 配置数据，不包含建表语句或时间戳列；敏感 env 值按配置明文进入 GitHub update-log。该转换仅生成 SQL，不执行 SQL；原 modify-log 仍按原文读取并原样纳入发布说明。

## 清空边界

当前发布流程不执行本地清空，也不调用 GitHub 写接口删除或截断源文件。GitHub 来源的 modify-log 只能被读取并纳入发布事实；旧的 compare-and-clear 兼容接口仍会拒绝 GitHub 来源，避免误操作远程仓库文件。
