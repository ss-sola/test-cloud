# 配置版本预览

## 页面交互

入口为管理台左侧的“配置版本预览”（`#config-file-preview`）。页面展示 Git 地址、分支、文件路径、tag 和只读文本预览表单，所有业务字段初始为空，用户必须显式填写后提交。

用户可在 Token 配置页面保存 GitHub Token；提交 preview 时页面将 `githubToken` 随请求发送。服务端不从环境变量或配置文件读取 Token，也不返回 Token。

内容写入 `<pre>` 的 `textContent`，不会被当作 HTML、脚本或可执行配置。复制失败时保留页面内容并显示可操作提示。

## API 交互

页面直接调用：

- `POST /api/config-file-preview/preview`：使用用户填写的 repository、branch、filePath、tag 和 Token 读取文件；
- `POST /api/config-file-preview/tags`：可选地按用户填写的 repository 查询 tags，不自动选择第一项；
- 不再调用 `GET /api/config-file-preview/defaults`，也没有固定仓库、文件路径或版本默认值。

## 可访问性与响应式

- 字段使用显式 `label`、原生约束和 `aria-describedby`。
- 错误区域使用 `role="alert"`。
- 结果区域使用 `aria-live="polite"` 与 `aria-busy`。
- 预览内容使用等宽字体，窄屏支持横向滚动但不撑破页面。
- 遵守 `DESIGN.md` 的 Flat 颜色、8px 间距和 reduced-motion 约定。

## 输入与安全边界

- repository、branch、filePath、tag 和 githubToken 均为请求必填字段，由 DTO 校验长度和类型。
- GitHub API 地址固定为 `api.github.com`，Token 不写入结果、页面文本、URL、日志或响应。
- 页面只能在受控管理网络或反向代理之后部署，生产环境应配置认证和 GitHub API 速率限制。
