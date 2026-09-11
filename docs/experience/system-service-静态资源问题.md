# system-service 静态资源构建与启动问题

## 问题一：静态资源没有复制到构建目录

### 触发条件

`apps/system-service/nest-cli.json` 将 `assets` 配置在顶层，或将项目根目录的资源路径误写为相对于项目根目录的路径。

### 现象

`nest build` 成功，但 `dist/public` 中没有页面文件，生产服务无法提供静态资源。

### 根因与解决方式

Nest CLI 读取的是 `compilerOptions.assets`，资源匹配路径相对于 `sourceRoot`（本项目为 `src`）。因此应使用：

```json
{
  "compilerOptions": {
    "assets": [
      {
        "include": "../public/**/*",
        "outDir": "dist/public"
      }
    ]
  }
}
```

## 问题二：浏览器脚本被服务端自动注册器加载

### 触发条件

静态 JS 复制到 `dist/public` 后，共享自动注册器递归扫描构建目录并将其作为 Node 模块加载。

### 现象

服务启动失败并报错：`ReferenceError: document is not defined`。

### 根因与解决方式

浏览器脚本顶层直接访问 `document`，不适合被 Node 加载。将脚本初始化包在 IIFE 中，并在访问 DOM 前增加运行环境保护：

```js
if (typeof document === 'undefined') {
  return;
}
```

浏览器环境仍会正常初始化，Node 扫描时会安全退出。

## 问题三：common-service 路径别名未转换导致启动失败

### 触发条件

服务启动时加载 `@nest-cloud/common`，但 common-service 的 `dist` 是通过裸 `tsc` 或不完整的 Nest 构建生成的，未经过 `tsc-alias`。

### 现象

system-service 启动失败，报错类似：

```text
Error: Cannot find module '@/exception/global.exception'
```

堆栈通常指向 `node_modules/@nest-cloud/common/dist` 内的文件。

### 根因与解决方式

根目录 `tsconfig.base.json` 为 common-service 配置了 `@/*` 路径别名。TypeScript 只负责按别名完成编译，不会自动改写生成 JavaScript 中的 `require('@/...')`；common-service 的正式构建脚本必须按 `tsc && tsc-alias` 执行。system-service 的启动脚本通过 `build:common` 在 `start`、`start:dev`、`start:debug` 和 `start:prod` 前执行这条完整构建链，避免启动时加载未转换的依赖产物。

不要用单独的 `tsc` 或直接 Nest 编译替代 common-service 的正式 build；如果已经生成坏产物，重新执行：

```bash
pnpm --dir apps/common-service run build
```
