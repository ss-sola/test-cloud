# 配置文件版本预览 API 与配置

## 配置来源

配置预览不提供公共业务默认值，也不读取 `.env`、配置中心或进程环境变量。`repositoryUrl`、`branch`、`filePath`、`tag` 和 `githubToken` 均由请求显式提供；Token 由当前浏览器的 Token 配置提交，服务端不会在响应中返回 Token。

## API

### 查询 tags（可选）

```http
POST /api/config-file-preview/tags
Content-Type: application/json
```

请求：

```json
{
  "repositoryUrl": "https://github.com/example/project.git",
  "githubToken": "github-token"
}
```

该接口只返回 GitHub 返回的 tag 列表，不自动选择 tag，也不提供默认仓库。

### 读取 tag 文件

```http
POST /api/config-file-preview/preview
Content-Type: application/json
```

请求：

```json
{
  "repositoryUrl": "https://github.com/example/project.git",
  "branch": "main",
  "filePath": "config/application.yml",
  "tag": "v1.0.0",
  "githubToken": "github-token"
}
```

服务端请求：

```text
https://api.github.com/repos/{owner}/{repo}/contents/{filePath}?ref={tag}
```

成功 `data`：

```json
{
  "repositoryUrl": "https://github.com/example/project.git",
  "branch": "main",
  "filePath": "config/application.yml",
  "selectedTag": "v1.0.0",
  "tags": [{ "name": "v1.0.0" }],
  "content": "...",
  "byteLength": 1234
}
```

页面必须让用户明确填写 tag；不会因 tags 列表存在而静默选中第一项。

## 错误状态

| 状态 | 场景 |
| --- | --- |
| 400 | DTO 字段缺失/超长、GitHub 仓库地址无法解析，或 branch/tag/filePath 字段无效 |
| 401 | GitHub Token 无效或缺失导致认证失败 |
| 404 | GitHub 仓库、tag 或文件不存在 |
| 413 | GitHub 响应、文件或内容超过大小限制 |
| 429 | GitHub API 请求受限 |
| 500 | 其他未处理的 GitHub API 错误 |

GitHub 原始响应体会随 `ProjectException` 记录到现有全局错误日志；Token 不会写入日志或响应头。生产环境应通过受控管理网络或反向代理保护接口，并配置 GitHub API 访问速率限制。

## 地址与 Token

GitHub API 地址固定为 `api.github.com`。请求缺少 `githubToken`、`repositoryUrl`、`branch`、`filePath` 或 `tag` 时由 Controller DTO 校验拒绝。私有仓库建议使用仅有目标仓库只读 Contents 权限的 Fine-grained Token，并仅通过 HTTPS 管理台提交。
