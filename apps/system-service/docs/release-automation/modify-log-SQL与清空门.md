# modify-log SQL 与清空门

`ModifyLogGatewayService` 只读取 basename 为 `modify-log.sql` 的受控文件，限制字节数、行数和控制字符。输入支持结构化 JSONL，或受控的 `INSERT`、`UPDATE`、`DELETE` 基本语句；未知动作、原始 SQL、危险标识符、未转义值和无 WHERE 的更新/删除都会拒绝。

`VersionSqlRenderer`：

1. 按 `occurredAt`、`sequence` 和稳定记录键排序；
2. 只生成白名单动作和引号标识符；
3. 使用 SQL 字符串转义；
4. 写入版本、source checksum、记录数、generator version 和 release unit 元数据；
5. 不执行 SQL。

`ModifyLogArchiveService.archive` 先写随机临时文件并 fsync，再 rename 到版本稳定路径；重新读取并 SHA-256 校验后才生成 `eligible-to-clear` metadata。归档失败或 checksum 不一致不会改变源文件。

## compare-and-clear

清空必须同时满足：

- `mode=apply`；
- 独立一次性 confirmation token；
- archive ID、版本、Job ID、source path、原始 checksum、generation 全部匹配；
- 当前文件仍名为 `modify-log.sql`，读取 checksum 与归档一致。

通过后只 truncate 原始 `modify-log.sql`，不删除 SQL artifact，不执行数据库 SQL。dry-run 永不清空。重复成功调用返回 `already-cleared`；文件被追加、替换或 token 被消费时拒绝并保留原文件。
