# 论文查重菜单执行记录

> 算法设计基线：仓库根目录 `docs/plan/plan.md`。本文件记录 `system-service` 的接入执行过程，不重复维护算法正文。

## 背景与范围

为系统管理台新增“论文查重”菜单，比较两段各不超过 10000 个字符的答案，支持相似阈值高亮、鼠标悬浮/键盘聚焦查看片段数据，并展示文本标准化、分句/分块、3-gram、块候选、Jaccard、SimHash、连续扩展、阈值筛选和最终区间九步数据。

本次只做无状态即时计算：不保存论文原文、规范化文本或结果，不新增数据库/Redis/文件/session/队列，不修改 `common-service`，不扩展为论文库或联网检索。

## 任务清单

| # | 任务 | 状态 | 备注 |
|---|---|---|---|
| 1 | 纯文本规范化与 UTF-16 原文位置映射 | 已完成 | 支持 NFKC、大小写、合法 HTML 标签和 code point 计算 |
| 2 | 3-gram、Jaccard、64 位 SimHash、LCS、多片段覆盖、上下文扩展、重复密度和区间合并 | 已完成 | 空特征、交叉顺序片段、密度评分、跨分块合并和重叠边界有回归测试 |
| 3 | DTO、Controller、Service 和 `POST /api/plagiarism/compare` | 已完成 | 请求级参数校验，ResponseUtil 包装 |
| 4 | 管理台菜单、fragment、路由挂载、阈值和编辑距离表单、双侧高亮 | 已完成 | 输入草稿缓存到 `nestcloud:plagiarism:v1`，请求显式提交 editDistance |
| 5 | 九步数据展示、静态契约测试和行为测试 | 已完成 | `test.md` 1～12 场景和 `test中.md` 中长篇 fixture 均有独立回归用例，分句/分块、连续扩展、双向重复率和 ENV 式原文叠层已覆盖 |
| 6 | 正式模块文档和前端文档同步 | 已完成 | `docs/plagiarism/算法与接口.md` 及 `docs/frontend/*` |
| 7 | lint、test、tsgo、构建与语法检查 | 已完成 | lint、test、tsgo、system-service build 和 Node 语法检查通过 |

## 关键契约

- 请求：`POST /api/plagiarism/compare`，字段为 `source`、`target`、可选 `threshold`。
- 阈值范围 `[0, 1]`，默认 `0.6`；编辑距离为非负整数且不设上限，默认 `2`。编辑距离控制连续证据之间允许的插入、删除或替换字符数；阈值只控制 `matches` 高亮筛选，不改变基于全部候选重复区间计算的综合相似度和重复率。
- 区间使用原始输入 UTF-16 半开区间 `[start, end)`；`length` 使用规范化 code point 数。
- 前端不使用 `innerHTML`、localStorage 或 sessionStorage 保存/渲染论文内容。
- 响应同时返回 `sourceToTarget` 和 `targetToSource` 两个方向；页面以 A → B 的 `matches` 高亮，并分别展示两个方向的重复率。
- `docs/plan/test.md` 的 12 个验收场景均有独立回归用例，测试使用连续文本、区间覆盖和重复率性质断言，不绑定某个样本的固定字符位置。

## 开始时间

2026-09-14

## 结束时间

2026-09-14 17:51:32

## 当前状态

已完成。`pnpm run lint`、`pnpm run test`、`pnpm run tsgo`、system-service 构建、Node 浏览器脚本语法检查和查重专项测试均通过；上下文/密度/跨块合并与编辑距离专项测试通过，仓库全量测试为 26 个文件、134 个测试。
