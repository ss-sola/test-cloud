# system-service

## 简介

`system-service` 是后台管理配置服务，当前首期包含两个模块：

- 字典管理
- 菜单路由管理

服务复用 `@nest-cloud/common` 提供的启动、配置中心、自动注册、TypeORM 与统一响应能力。

## 代码入口

- 启动入口：`src/main.ts`
- 模块入口：`src/app.module.ts`
- 字典控制器：`src/modules/dictionary/controller/dictionary.controller.ts`
- 菜单路由控制器：`src/modules/menu-route/controller/menu-route.controller.ts`

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

模块文档按功能拆分在 `docs/`：

- [文档导航](./docs/index.md)
- [dictionary 模块](./docs/dictionary/README.md)
- [menu-route 模块](./docs/menu-route/README.md)
- [改造过程记录](./docs/plan/system-service-收敛改造记录.md)

## 当前能力

- 静态管理页入口：`/public/index.html`
- 当前管理台左侧导航由 `menu-route` 树接口实际驱动

### 字典管理

- 命名空间查询
- 字典项查询、新增、更新、删除
- 按 keys 批量过滤
- 批量导入
- 空表默认数据初始化
- 默认数据收敛为当前系统基础字典
- 对应静态管理页：`/public/index.html#/dictionary`

### 菜单路由管理

- 菜单列表与树查询
- 菜单增删改查
- 排序、启停、隐藏控制
- 权限码绑定
- 空表默认菜单初始化
- 菜单修改后联动刷新当前管理台左侧导航
- 对应静态管理页：`/public/index.html#/menu-route`

## 维护约束

- 接口、配置键、种子结构变化时，必须同步更新对应模块文档。
- 若 `system-service` 对外接口或项目职责发生变化，必须同步更新根级 `docs/project/`。
