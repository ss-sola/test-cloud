# modify-log SQL 与归档门

`ModifyLogGatewayService` 通过 GitHub Contents API 读取发布 ref 中的仓库相对路径，页面默认路径为 `.version/modify-log.sql`。路径必须以 `modify-log.sql` 结尾，不能是绝对路径或包含路径穿越；服务端不从 `process.cwd()`、本地工作区或同名本地文件读取。

读取顺序如下：

1. 优先使用本次发布已冻结的 candidate SHA；未执行 Git tag 步骤时使用 `dev/master`；
2. 调用 GitHub Contents API，解码返回的 base64 内容并记录 GitHub blob SHA 与内容 checksum；
3. 将文件原文直接作为 SQL artifact 输入，不解析 SQL 动作、不重排语句、不执行 SQL；
4. apply 模式通过 `ModifyLogArchiveService` 原子写入归档文件，并重新读取归档文件校验 artifact checksum；dry-run 不写归档。

服务只保留响应大小和行数上限，避免异常大的远程内容进入任务；这些限制不是 SQL 语法校验。归档 metadata 保存仓库、ref、blob SHA、源 checksum 和 artifact checksum，重复执行使用稳定归档 ID。

## 清空门

GitHub 来源的 modify-log 只能读取和归档，不能通过服务端 `open(..., 'r+')` 清空本地文件，也不能通过当前只读 Contents API 修改远程仓库。对 GitHub 来源调用 `compare-and-clear` 会被拒绝；不会因为服务端存在同名文件而误删或截断它。

`compare-and-clear` 仅保留给旧的本地来源兼容调用，必须同时满足：

- `mode=apply`；
- 独立一次性 confirmation token；
- archive ID、版本、Job ID、source path、原始 checksum、generation 全部匹配；
- 当前本地文件仍名为 `modify-log.sql` 且内容未变化。
