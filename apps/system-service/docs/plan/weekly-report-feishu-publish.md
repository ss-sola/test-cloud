# 周报按月 Sheet / 工作日单元格发布计划

> 历史记录：2026-09-02 起，月度目标配置已由单目标 Wiki 配置替代，当前规则见[周报飞书单目标配置调整记录](./weekly-report-feishu-single-target.md)。本文保留首版按月方案的实施过程。

- 开始时间：2026-09-01 10:39:00
- 结束时间：2026-09-01 11:07:02
- 耗时：约 28 分钟
- 当前状态：已实现并完成自动化验证；待配置 Bot 与月度 Sheet 后进行真实 smoke test

## 背景

周报目前只生成 Markdown 并由管理台复制/下载。飞书目标 Wiki 节点实际为 Sheet：A 列为周日期范围，B 列为姓名，C-G 列分别为周一至周五；每月使用不同 Sheet。发布必须只修改匹配行的 C-G 五格，不能清空或覆盖其它单元格。

## 方案

使用飞书官方 Wiki/Sheets API 和 Bot `tenant_access_token`，禁止使用网页内部 `user_changes`、Cookie、CSRF 或 gzip+Base64 协议。月度 Sheet 由服务端配置；只读配置的 A:B 范围，按日期范围和姓名精确定位行；只读目标 C:G 比较，内容一致则跳过，否则一次更新 `C{row}:G{row}`。不写 marker/hash 到表格，不清空范围。发布失败与报告生成失败分离，保留 Markdown 降级。

首版针对 `last-week` 的五日摘要；`this-week` 保持现有生成/下载行为，未形成完整五日数据时不写入。

## 任务

1. 增加月度 Sheet 配置、Bot 凭据和安全校验。
2. 实现 Feishu 认证、Wiki 节点解析、Sheets 读取/单范围更新客户端，统一超时、有限重试和错误转换。
3. 实现日期/姓名精确定位与五日纯文本摘要映射。
4. 接入异步周报 Job，增加独立 publication 状态；保持未启用发布时的兼容行为。
5. 增加 DTO、单元测试、前端最小状态展示，并同步模块文档和 ApiFox。
6. 执行 `pnpm run lint`、`pnpm run test`、`pnpm run tsgo`，使用专用测试 Sheet 进行人工 smoke test。

## 实施结果

- 已新增 system-service 内 Feishu HTTP/Auth/Wiki/Sheets 客户端，使用官方 Open API 和 Bot token；未修改 common-service。
- 已新增按月份配置、A/B 日期与姓名唯一匹配、C:G 五格纯文本映射和相同内容跳过逻辑；无清空、无整表写入。
- 已接入异步 Job 的独立 publication 状态及管理台反馈；发布失败保留 Markdown。
- 已补充 Feishu、定位、映射及 Job 回归测试；system-service 共 49 项测试通过。
- 已同步 NestCloud ApiFox 项目中的周报任务、状态和同步生成接口说明。
- 已完成根目录 `pnpm run lint`、`pnpm run test`、`pnpm run tsgo`；尚未使用真实 Bot 凭据执行线上 Sheet 写入。

## 安全与验收标准

- A/B 仅读，写请求唯一目标为匹配行的 C:G；不调用 clear、不整行/整列/整表更新。
- 零行或多行匹配直接失败且不写入；相同五格内容返回 skipped。
- 目标月份不存在配置、目标不是 Sheet、Bot 无权限或范围非法时不写入。
- 401/403/匹配失败不盲目重试，429/5xx/超时有限重试；任何错误不返回凭据。
- 报告生成成功而发布失败时仍返回 Markdown 和可下载结果。
- 普通测试不连接真实飞书。
