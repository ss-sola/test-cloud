# nest-cloud

## 简介

`nest-cloud` 是一个基于 `apps/*` 工作区组织的多应用后端仓库。

当前仓库实际包含以下子项目：

- `apps/common-service`：统一基础设施内核
- `apps/config-service`：Nacos-like 简化控制面（配置中心与注册中心）
- `apps/system-service`：系统管理服务，承载前后台统一账号主体、认证与权限等能力
- `apps/stock-service`：公开股票行情稳定增长分析与静态展示服务

## 架构分层

### common-service

`common-service` 负责沉淀其他服务共用的基础设施能力，当前已确认包括：

- 配置中心接入
- 注册中心客户端
- 统一日志
- TypeORM 数据库接入

### config-service

`config-service` 负责基础设施层能力：

- 配置文件管理、发布与客户端拉取
- 服务注册、发现、心跳与审计

### system-service

`system-service` 提供系统管理能力，并以 `account` 作为前后台统一登录与用户主体。当前模块包括：

- 账号、认证、角色、权限与运行时权限管理

### stock-service

`stock-service` 提供公开股票行情稳定增长分析与静态结果展示能力。

## 常用根命令

```bash
pnpm install
pnpm build
pnpm start:config
pnpm start:system
pnpm start:stock
pnpm lint
pnpm tsgo
```

其中 `pnpm tsgo` 会先构建 `apps/common-service`，再通过 `tsgo` 执行根级类型检查。

当前仓库已经声明 `pnpm-workspace.yaml` 与根级 `packageManager`，正式文档和后续命令约定统一以 `pnpm` 为准。

## 文档导航

### 项目级文档

- [项目架构文档导航](./docs/project/index.md)
- [架构总览](./docs/project/架构总览.md)
- [配置中心与注册中心](./docs/project/配置中心与注册中心.md)
- [开发与校验](./docs/project/开发与校验.md)
- [部署与可观测性](./docs/project/部署与可观测性.md)
- [失败经验导航](./docs/experience/index.md)

### 服务级文档

- [common-service 文档](./apps/common-service/docs/index.md)
- [config-service 文档](./apps/config-service/docs/index.md)
- [system-service 文档](./apps/system-service/docs/index.md)
- [stock-service 文档](./apps/stock-service/docs/index.md)

## 文档维护规则

- `/docs/project` 只存放项目级架构设计文档。
- `/docs/experience` 只存放任务执行中的失败经验。
- 同一类内容必须按职责或功能拆分，索引页只做导航，不承载整类正文。
- `apps/common-service` 的文档按共享能力拆分到自身 `docs/`。
- 其他 `apps/*` 子项目都必须在各自根目录维护 `docs/<模块>/`。

## 开发约束摘要

- 配置统一通过 `getConfig` 和 `ConfigKey` 获取。
- 日志统一使用 logger，不使用 `console`。
- 可复用静态值应提取为常量。
- 无状态通用逻辑优先收敛到 `utils`。
- 架构、共享能力、服务模块或失败经验发生变化时，必须同步更新对应文档。
