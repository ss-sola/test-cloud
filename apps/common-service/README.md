# common-service

## 简介

`common-service` 是当前仓库的共享基础能力包，供其他服务统一复用。

当前已明确的共享能力包括：

- 配置中心接入
- 注册中心客户端
- 统一日志
- TypeORM 数据库接入

包信息见：`apps/common-service/package.json`

## 代码入口

- 配置中心：`src/config-center/index.ts`
- 注册中心客户端：`src/client/registry-client.service.ts`
- 日志：`src/logger/logger.service.ts`
- 数据库接入：`src/database/enable-typeorm.decorator.ts`

## 常用命令

```bash
pnpm install
pnpm --dir ./apps/common-service build
pnpm --dir ./apps/common-service lint
```

## 文档导航

详细文档按共享能力拆分维护在 `docs/`：

- [文档导航](./docs/index.md)
- [配置中心接入](./docs/config-center/README.md)
- [注册中心客户端](./docs/registry-client/README.md)
- [日志能力](./docs/logger/README.md)
- [数据库接入](./docs/database/README.md)

## 维护约束

- 这里只承载共享能力，不承载业务服务私有逻辑。
- 共享能力接口、配置规则、默认行为变化时，必须同步更新 `docs/` 下对应目录。
