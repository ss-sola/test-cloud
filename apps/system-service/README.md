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
- [静态管理台初始化计划](../../docs/plan/system-service-静态管理台初始化.md)

## 前端静态管理台

- 页面入口：`/public/index.html`
- 静态资源源目录：`public/`，由 `@nestjs/serve-static` 提供访问
- 页面结构：左侧主导航、右侧主体内容区
- 页面提供工作台总览、图片转粒子、JSON 对比、ENV 对比和周报生成五个 hash 入口
- 三个本地工具均在浏览器本地处理，不上传图片、JSON 或 ENV 内容
- 周报生成通过受约束的后端 API 读取白名单 Git 仓库，支持源项目的 `week:last` 与 `week:this` 周期，并返回可复制/下载的 Markdown
- 页面设计遵循仓库根目录 `DESIGN.md`

## 维护约束

- 接口、配置键、种子结构变化时，必须同步更新对应模块文档。
- 若 `system-service` 对外接口或项目职责发生变化，必须同步更新根级 `docs/project/`。
