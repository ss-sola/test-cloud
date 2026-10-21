# 前端管理台文档

## 文档导航

- [模块总览](./模块总览.md)
- [实现逻辑](./实现逻辑.md)
- [前端交互](./前端交互.md)
- [JSON/ENV 内容对比](../content-compare/README.md)
- [工作流画布](../workflow/README.md)
- [周报生成](./周报.md)
- [周报生成与飞书写入实现](./周报生成与飞书写入实现.md)
- [BullMQ 面板](./bullmq-dashboard.md)
- [配置版本预览](./config-file-preview.md)
- [论文查重算法与接口](../plagiarism/算法与接口.md)

管理台提供十个入口：工作台总览、图片转粒子、JSON 对比、ENV 对比、工作流、周报生成、BullMQ 面板、配置版本预览、论文查重和 Token 配置。页面由 `system-service` 通过 `/public` 静态托管；业务页面 section 位于 `public/html/`，由 `app.js` 加载后挂入 `#view-host`。图片处理仍在浏览器本地完成；JSON/ENV 原文仅在点击比较或对调时发送到本服务即时计算，后端不持久化、不缓存或外发。其他入口及调用说明见各模块文档。
