# 发布自动化

本模块为输入 `gitTag` 的第三方项目发布单元提供受控的远程执行流程。发布单元由以下字段组成：

```text
repository + currentBranch + targetBranch + gitTag
```

## 文档导航

- [配置与安全边界](./配置与安全边界.md)
- [HTTP API](./HTTP-API.md)
- [Job 状态、进度与幂等](./Job状态与幂等.md)
- [modify-log SQL 与清空门](./modify-log-SQL与清空门.md)
- [Jenkins 与 GitHub 适配器](./外部适配器.md)

## 当前交付范围

- 页面分别收集当前/source 分支 `branch` 和目标分支 `targetBranch`；tag、update-log 和 PR head 使用当前分支，targetBranch 用作 PR base 与 Jenkins 构建分支。
- GitHub tag 创建、PR 查询/提交/复用、SHA 快照和 422 并发对账；不调用 Merge API，不执行本地 Git。
- 首次 apply 在 tag 后读取 modify-log、生成 Markdown，再提交/复用 PR 并进入 `manual_intervention`；PR 合并后新 Job 自动识别已合并 PR 并继续 Jenkins、modify-log 和 Feishu。
- modify-log 在 PR 前从 GitHub 读取并由发布 docs 复用；Jenkins queue/build/text 轮询和 Feishu 未接通阻断等能力仍受流程门禁保护。
- 提供测试同步执行入口 `POST /api/release-automation/test/execute`；默认 dry-run，不创建 BullMQ Job。

## 冲突处理原则

GitHub PR 的冲突不在 NestCloud 服务端自动解决。服务端只提交或复用 PR，展示 GitHub URL，并在 PR 未合并期间拒绝继续后置步骤。维护人员在 GitHub 上解决冲突并完成审核；合并后重新发起完整发布 Job。多个重复 PR、来源 SHA 变化和创建 422 无法对账时 fail closed，要求人工清理或重新 plan。

## 当前限制

本模块不会执行本地 Git merge、clone、pull、fetch、checkout 或 worktree，不在本地拉取或构建第三方代码，不执行 SQL。远程分支、文件读取和 update-log 写入全部通过 GitHub API；Feishu 文档写入仍需后续独立契约。
