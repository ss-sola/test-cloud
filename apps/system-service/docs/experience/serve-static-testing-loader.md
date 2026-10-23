# Nest 静态托管测试返回 404 的空加载器问题

## 触发条件

使用 `Test.createTestingModule({ imports: [AppModule] }).compile()`，然后创建 Nest 应用并请求 ServeStaticModule 路径。配置和文件都正确，但静态请求返回 `Cannot GET ...`。

## 根因

`@nestjs/serve-static` 在 provider 创建时根据 `HttpAdapterHost.httpAdapter` 选择加载器。TestingModule 编译阶段尚未创建 HTTP 适配器，因此选中 NoopLoader，之后 `createNestApplication()` 不会重新选择加载器。正式 `NestFactory.create` 的生命周期不同，不代表生产配置错误。

## 处理

仅在集成测试中将 `AbstractLoader` provider 替换为真实 `ExpressLoader`，再创建应用并初始化；不要因此改掉正式静态映射，或手动增加与正式路径不同的 Express 托管入口。依赖内部测试入口时应在升级 `@nestjs/serve-static` 后重新检查。

## 验证

参见 `src/__tests__/workflow-directory-static.spec.ts`：真实请求验证新增文件和修改立即可读、隐藏临时文件与锁拒绝访问、缺失文件不回退旧目录。所有测试仅使用项目内专用临时目录，不改实际工作流样例。
