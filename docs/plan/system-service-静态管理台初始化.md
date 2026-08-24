# system-service 静态管理台初始化

## 背景

`system-service` 需要一个可运行的前端页面骨架，统一承载系统配置模块。项目已声明 `@nestjs/serve-static`，但缺少页面资源、静态服务注册和左侧导航布局。

## 任务清单

- [x] 在 `AppModule` 注册 `/public` 静态资源服务。
- [x] 初始化 `public/index.html`、`public/css/app.css` 和 `public/js/app.js`。
- [x] 实现左侧一级导航、可折叠二级菜单、hash 导航和右侧主体区域。
- [x] 实现 768px 以下移动端侧栏抽屉和键盘/无障碍支持。
- [x] 修正 `nest-cli.json`，确保项目根 `public/` 资源复制到 `dist/public`。
- [x] 同步 `system-service` README 和前端模块正式文档。
- [x] 完成构建、HTTP 和浏览器交互验证。
- [x] 执行 lint、test 和 tsgo。

## 时间记录

- 开始时间：2026-08-24
- 结束时间：2026-08-24
- 耗时：约 1 小时
- 当前状态：已完成

## 结果

静态管理台通过 `/public/index.html` 访问。页面资源唯一源目录为 `apps/system-service/public/`，构建后复制到 `dist/public/`；当前仅保留工作台总览，原先预留的字典管理和菜单路由入口已移除。

## 验证记录

- `pnpm --dir apps/system-service build`：通过，确认 `dist/public/index.html` 存在。
- HTTP 验证：HTML、CSS、JS 均在 3500 端口返回 200。
- 浏览器验证：桌面和 375px 移动布局、二级菜单折叠、hash 导航、刷新恢复、移动端抽屉和无横向溢出均通过。
- `pnpm run lint`：通过。
- `pnpm run test`：通过，common-service 10 个测试文件、25 个测试用例通过；system-service 当前无测试文件。
- `pnpm run tsgo`：通过。
