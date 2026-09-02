# BullMQ 面板

## 访问

管理台菜单“BullMQ 面板”通过 iframe 加载 Bull Board：

```text
/ops/queues/
```

也可以直接在新窗口打开该地址。面板只允许 GET 请求，写操作统一返回 405；Redis stats 不对页面开放。

## 队列配置

队列名称和 Redis key prefix 固定定义在周报模块常量中，不从配置文件或浏览器参数读取：

```typescript
WEEKLY_REPORT_QUEUE_NAME = 'weekly-report'
WEEKLY_REPORT_QUEUE_PREFIX = 'bull'
```

Redis 连接沿用服务端现有配置：

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `SessionRedisUrl` | 空 | BullMQ Queue/Worker 使用的 Redis URL，只接受 `redis://` 或 `rediss://`，可带数字 DB 路径 |
| `NodeEnv` | `development` | 生产环境自动要求面板登录 |

例如本地 Redis：

```env
SessionRedisUrl=redis://127.0.0.1:6379/0
```

面板固定展示 `weekly-report` 队列。当前周报 Job 已迁移为 BullMQ Worker 执行，因此任务会出现在该队列中。没有可用 Redis 时服务无法创建队列 Worker，应先启动 Redis。

## 安全边界

- 队列名和 key prefix 来自服务端代码常量，Redis URL 只来自服务端配置，不能由 URL 参数、请求体或页面脚本覆盖。
- 所有 `BullMQAdapter` 使用 `readOnlyMode`，外层 middleware 额外拒绝非 GET 请求。
- 面板可能展示 Job data、return value、失败堆栈和日志，周报任务已在终态清理敏感发布配置；其他队列也不得放入密码、Token 或其他敏感数据。
- 生产环境必须使用 HTTPS、登录会话和固定的 `ops:queue:read` 权限，并建议在反向代理层限制管理网段。
- Redis 账号应使用独立 ACL、独立 DB 或 key prefix，避免读取 Session 或其他业务数据。

## 实现位置

- 配置：`src/modules/bullmq-dashboard/bullmq-dashboard.config.ts`
- 面板服务：`src/modules/bullmq-dashboard/bullmq-dashboard.service.ts`
- 面板常量：`src/modules/bullmq-dashboard/bullmq-dashboard.constants.ts`
- 管理台 fragment：`public/html/bullmq.html`
- 菜单和路由：`public/index.html`、`public/js/app.js`
- 测试：`src/__tests__/bullmq-dashboard.config.spec.ts`、`bullmq-dashboard.service.spec.ts`、`frontend-logic.spec.ts`
