# 前端管理台文档

## 文档导航

- [模块总览](./模块总览.md)
- [实现逻辑](./实现逻辑.md)
- [前端交互](./前端交互.md)
- [周报生成](./周报.md)
- [周报生成与飞书写入流程](./周报生成与飞书写入流程.md)
- [周报生成与飞书写入实现思路](./周报生成与飞书写入实现思路.md)
- [BullMQ 面板](./bullmq-dashboard.md)
- [配置版本预览](./config-file-preview.md)
- [发布自动化](../release-automation/README.md)

管理台提供工作台总览、图片转粒子、JSON 对比、ENV 对比、周报生成、BullMQ 面板、配置版本预览、发布自动化和 Token 配置。页面由 `system-service` 通过 `/public` 静态托管；业务页面 section 位于 `public/html/`，由 `app.js` 加载后挂入 `#view-host`。本地工具不会上传用户素材或配置内容。周报和配置版本预览通过请求显式携带业务输入后读取 Git 内容，配置预览不再提供服务端业务默认值。BullMQ 面板由服务端独立挂载到 `/ops/queues/`，只展示固定的 `weekly-report` 队列；发布和周报均由请求运行参数驱动。
