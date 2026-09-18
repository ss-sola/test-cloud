# 发布自动化 AI Markdown 接通记录

## 背景

Token 配置已保存 OpenAI-compatible AI 配置，但发布自动化只传递 GitHub/Jenkins 凭据，`release-docs` 仍是占位阻断。本次接通发布 AI，自动按 GitHub Tags API 顺序解析上一 tag 与当前 tag，固定收集两者之间的提交、ENV 和 modify-log 事实，不按 person 筛选提交；生成只读 Markdown 并返回，不提交 GitHub 或 Feishu。

## 任务清单

| # | 任务 | 状态 | 结果 |
|---|---|---|---|
| 1 | 抽取共享 OpenAI-compatible transport | 已完成 | 周报和发布共用 Bearer、timeout、响应结构及大小检查 |
| 2 | 接入 release runtime.ai 与强制 releaseDocs DTO/Controller/前端 | 已完成 | 复用 `nestcloud:release-tokens:v1` nested `ai` 配置，自动解析相邻 tag |
| 3 | 实现相邻 tag、ENV、modify-log 事实收集与无 person 过滤 | 已完成 | GitHub Tags API 自动定位上一/当前 tag；compare 提交、ENV diff 和 modify-log 必定读取 |
| 4 | 实现结构化 AI 摘要、本地降级和确定性 Markdown | 已完成 | factRef 校验，AI 失败时 degraded 本地摘要 |
| 5 | 接入执行器、默认任务和凭据终态清理 | 已完成 | 先 ensure 当前 tag，再生成相邻 tag docs；modify-log 读取/渲染/apply 归档；Feishu 早期阻断；终态移除 runtime/pageConfig |
| 6 | 测试、文档和全量验证 | 已完成 | AI client、release docs、前端和全量测试通过 |

## 边界

- Markdown 只生成并通过 Job progress/status 返回，不调用 GitHub 文档写入或 Feishu 文档 API。
- 发布整理不按提交人筛选；作者只作为事实字段保留。
- AI 只输出带事实引用的 JSON 摘要，服务端渲染最终 Markdown，避免模型直接控制文档结构。
- `modify-log` 已接通读取、确定性渲染和 apply 归档；源文件清空仍需独立确认门。`feishu` 尚未实现时，在任何 tag/merge/Jenkins 远程写操作前阻断。
- 不修改 `apps/common-service`。

## 验证结果

- 受影响回归测试与新增测试通过。
- `pnpm run lint`：通过。
- `pnpm run test`：通过（29 个测试文件、147 个测试）。
- `pnpm run tsgo`：通过。
- `git diff --check`：通过。

## 时间

- 开始：2026-09-16 17:20 +08:00
- 完成：2026-09-16 17:51 +08:00
- 耗时：31 分钟

## 当前状态

已完成。
