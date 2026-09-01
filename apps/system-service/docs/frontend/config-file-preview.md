# 配置版本预览

## 页面交互

入口为管理台左侧的“配置版本预览”（`#config-file-preview`）。页面按上下顺序展示：

1. Git 地址、分支、文件路径和 tag 配置表单；
2. 当前 tag 的文件元信息与只读纯文本预览。

页面加载时先调用 `GET /api/config-file-preview/defaults`，将 `config-file-preview.defaults.ts` 中的默认地址、分支、文件路径和 tag 填入表单；随后调用 `POST /api/config-file-preview/tags` 加载全部 tag 名称。用户可以修改这些值，提交表单后 `POST /api/config-file-preview/preview` 直接读取 GitHub Contents API 的 base64 文件内容。

内容写入 `<pre>` 的 `textContent`，不会被当作 HTML、脚本或可执行配置。复制失败时保留页面内容并显示可操作提示。

## 可访问性与响应式

- 字段使用显式 `label`、原生约束和 `aria-describedby`。
- 错误区域使用 `role="alert"`。
- 结果区域使用 `aria-live="polite"` 与 `aria-busy`。
- 预览内容使用 JetBrains Mono 等宽字体，窄屏支持横向滚动但不撑破页面。
- 遵守 `DESIGN.md` 的 Flat 颜色、8px 间距和 reduced-motion 约定。

## 服务端配置

- Token 配置键为 `GITHUB_TAG_FILE_TOKEN`，只从系统环境变量读取，页面不会接收或保存 Token。
- 页面只把 Git 地址、分支、文件路径和 tag 提交给 system-service，GitHub API 由服务端调用。
- 当前读取代码保持简单的字符串 URL 拼接，不再使用 `security.util.ts`、Git CLI 或多层 API 适配器。

## 保留的输入和资源约束

- branch/tag 仍由 DTO 拒绝控制字符、路径穿越和危险 ref；文件路径限制为安全的相对路径。
- GitHub 返回文件内容后才展示，响应必须包含 base64 `content` 字段。
- 单文件默认最多 200 KiB，GitHub 响应和 API 请求受现有配置限制。
- 旧请求被 AbortController 取消，旧响应不会覆盖新结果。

地址校验已关闭，API 只能部署在受控管理网络或反向代理之后，不能直接暴露到未认证公网。多实例部署还应由网关提供速率限制。
