# system-service

## 简介

`system-service` 是后台管理配置服务，同时提供静态管理台页面入口。

服务复用 `@nest-cloud/common` 提供的启动、配置中心、自动注册、TypeORM 与统一响应能力。

## 代码入口

- 启动入口：`src/main.ts`
- 模块入口：`src/app.module.ts`

## 常用命令

```bash
pnpm install
pnpm start:dev
pnpm build
pnpm lint
pnpm test
pnpm test:e2e
```

也可以在仓库根目录执行：

```bash
pnpm start:system
```

## 文档导航

- [前端管理台文档](./docs/frontend/README.md)
- [BullMQ 面板与配置](./docs/frontend/bullmq-dashboard.md)
- [发布自动化文档](./docs/release-automation/README.md)
- [周报飞书发布计划](./docs/plan/weekly-report-feishu-publish.md)
- [周报飞书单目标配置调整记录](./docs/plan/weekly-report-feishu-single-target.md)
- [静态管理台初始化计划](../../docs/plan/system-service-静态管理台初始化.md)

## 前端静态管理台

- 页面入口：`/public/index.html`
- 静态资源源目录：`public/`，由 `@nestjs/serve-static` 提供访问
- 页面结构：左侧主导航、右侧主体内容区；入口 `index.html` 只保留壳层，业务 section 位于 `public/html/` 并由 `app.js` 动态加载
- 页面提供工作台总览、图片转粒子、JSON 对比、ENV 对比、周报生成、BullMQ 面板、配置版本预览和 1.9.0 发布计划八个 hash 入口
- 1.9.0 发布计划默认以 dry-run 创建幂等 Job，服务端显示 GitHub 远程分支计划、Jenkins 验证/打包、更新文档和 `modify-log.sql` 清空门；缺少 Redis、Jenkins 凭据或完整 Pipeline 文本接口时保持 blocked，不发起真实副作用
- 三个本地工具均在浏览器本地处理，不上传图片、JSON 或 ENV 内容
- BullMQ 面板通过 `/ops/queues/` 提供只读 Bull Board，固定展示 `weekly-report` 队列，使用 `bull` prefix；Redis 连接沿用 `SessionRedisUrl`，详细配置与生产限制见 [BullMQ 面板与配置](./docs/frontend/bullmq-dashboard.md)
- 周报生成通过 GitHub Commits API 读取配置白名单中的 GitHub 仓库，使用 `GITHUB_TAG_FILE_TOKEN` 系统环境变量；页面通过 Job 状态轮询显示后端真实进度，单个项目失败时跳过并返回 `projectErrors`，其余项目继续生成可复制/下载的 Markdown。启用飞书发布后，`last-week` 周报使用单个 Wiki 配置，固定在 `A1:B200` 匹配 A 列日期范围和 B 列姓名，并只更新该行 C-G 五个工作日单元格；相同内容跳过，发布失败仍保留 Markdown。
- 页面设计遵循仓库根目录 `DESIGN.md`

## 维护约束

- 接口、配置键、种子结构变化时，必须同步更新对应模块文档。
- 若 `system-service` 对外接口或项目职责发生变化，必须同步更新根级 `docs/project/`。
