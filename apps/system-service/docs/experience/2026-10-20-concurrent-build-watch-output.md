# 并行构建与开发监听争用 dist

## 问题

`nest start --watch` 启动后出现 `Cannot find module './modules/content-compare/content-compare-http.service'`，同时 TypeScript 显示 `Found 0 errors`。缺失的模块源文件实际存在，没有发生接口代码删除。

## 触发条件

- `nest-cli.json` 配置 `deleteOutDir: true`，开发监听和独立构建使用同一份 `dist/`。
- `scripts/run-tsgo.mjs` 为构建临时创建/删除 `tsconfig.build.json`，并执行各项目 `build`。
- 另一个终端或并行任务同时执行 `nest start --watch` 或其他 build，导致监听器重编译/启动时输出目录正在被另一构建清理。

## 定位方式

先检查实际进程、监听端口、编译诊断和 `dist/modules` 中目标文件是否存在。不能把运行时缺失模块直接判断为源文件或导入错误，也不要为了掩盖问题修改业务 import。

## 处理方式

同一子项目的会清理输出目录的构建需要串行执行，不与开发监听的首次编译并行启动。统一完成 build/tsgo 后再进行浏览器验收；如输出目录已被争用，先完成一次完整构建，确认产物齐全，再由开发服务的正常热更新恢复。已有开发服务不要未经授权主动停止。

## 本次边界

仅记录执行经验，没有修改公共服务或仓库构建脚本。该问题不影响工作流节点或现有内容对比算法。
