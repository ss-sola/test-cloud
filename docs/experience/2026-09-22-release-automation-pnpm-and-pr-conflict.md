# 发布自动化：pnpm 版本切换与远程 PR 冲突

## 触发条件

第三方项目发布流程需要只通过 GitHub/Jenkins/Feishu 远程 API 工作，不拉取第三方代码、不在本地 merge 或构建。实现 GitHub Merge API 改为 Pull Request 后，需要同时处理 PR 并发创建、GitHub mergeability 状态和本地检查环境启动失败。

## 根因

根 `package.json` 原先声明 `pnpm@10.28.2`，本机可用版本为 `11.21.0`。pnpm wrapper 按项目声明尝试切换到 `.pnpm-store/v11/links/@/pnpm/10.28.2/...`，但该自动版本管理链接不完整，最终以 ENOENT 失败。`.pnpm-store` 是 pnpm 的内容寻址依赖缓存和自动版本管理缓存，不是 NestCloud 运行时业务目录，也不应提交到仓库。

## 处理方式

- 项目不要求固定 pnpm 大版本，因此将 `packageManager` 更新为本机可用的 `pnpm@11.21.0`；
- 保持 `.pnpm-store` 在 `.gitignore` 中，不删除、不提交、不把缓存路径写入业务配置；
- 直接使用已有 `node_modules` 运行 Vitest，避免 pnpm 因模块状态不一致自动清理/重装依赖；
- pnpm 启动后不再引用 10.28.2 的损坏缓存路径。

## PR 冲突处理

创建 PR 后读取 GitHub 返回的 `mergeable` 和 `mergeable_state`：明确 `mergeable=false` 或 `dirty` 时将 GitHub 任务标记为 `blocked`，Job 进入 `manual_intervention`，不执行 Jenkins、modify-log 或 Feishu；`null`/`unknown` 不误判。创建 422 只有响应明确表示已有 PR 时才允许查询并复用，其他校验错误直接 fail closed。冲突只在 GitHub 上由授权人员解决，合并后重新提交发布 Job。
