# 配置文件版本预览 API 与配置

## 默认值

默认值集中在：

`src/modules/config-file-preview/config-file-preview.defaults.ts`

当前默认值：

```json
{
  "repositoryUrl": "https://github.com/whtthd/wzj-nodejs-v2.git",
  "branch": "dev/master",
  "filePath": "env/sample/sample.custom-wzj.env",
  "tag": "v1.8.0-2026-08-20"
}
```

页面启动时调用默认值接口加载这些字段，用户修改不会回写 TypeScript 文件。

GitHub Token 只从系统环境变量 `GITHUB_TAG_FILE_TOKEN` 读取，不从 `.env` 或配置中心读取。Token 不返回浏览器。

## API

### 获取默认值

```http
GET /api/config-file-preview/defaults
```

响应使用 `ResponseUtil` envelope，`data` 为默认值对象。

### 首次加载 tag

```http
POST /api/config-file-preview/tags
Content-Type: application/json
```

请求：

```json
{
  "repositoryUrl": "https://github.com/whtthd/wzj-nodejs-v2.git"
}
```

服务端直接请求：

```text
https://api.github.com/repos/{owner}/{repo}/tags
```

`data` 是 GitHub 返回的 tag 数组，页面首次进入时将名称写入 tag 输入框的 datalist。

### 读取 tag 文件

```http
POST /api/config-file-preview/preview
Content-Type: application/json
```

请求：

```json
{
  "repositoryUrl": "https://github.com/whtthd/wzj-nodejs-v2.git",
  "branch": "dev/master",
  "filePath": "env/sample/sample.custom-wzj.env",
  "tag": "v1.8.0-2026-08-20"
}
```

服务端直接请求：

```text
https://api.github.com/repos/{owner}/{repo}/contents/{filePath}?ref={tag}
```

然后执行：

```ts
const data = await response.json();
const content = Buffer.from(data.content, 'base64').toString('utf-8');
```

成功 `data`：

```json
{
  "repositoryUrl": "https://github.com/whtthd/wzj-nodejs-v2.git",
  "branch": "dev/master",
  "filePath": "env/sample/sample.custom-wzj.env",
  "selectedTag": "v1.8.0-2026-08-20",
  "tags": [{ "name": "v1.8.0-2026-08-20" }],
  "content": "...",
  "byteLength": 1234
}
```

## 错误状态

| 状态 | 场景 |
| --- | --- |
| 400 | GitHub 仓库地址无法解析，或 branch/tag/filePath 字段格式无效 |
| 401 | GitHub Token 无效或缺失导致认证失败 |
| 404 | GitHub 仓库、tag 或文件不存在 |
| 413 | GitHub 响应、文件或内容超过大小限制 |
| 429 | GitHub API 请求受限 |
| 500 | 其他未处理的 GitHub API 错误 |

GitHub 原始响应体会随 `ProjectException` 记录到现有全局错误日志；Token 不会写入日志或响应头。生产环境应通过受控管理网络或反向代理保护接口，并配置 GitHub API 访问速率限制。

## 地址与 Token

本模块不再使用 `security.util.ts`，也不做 Git 地址、DNS 或 host 白名单校验。Git 地址只用于提取 GitHub owner/repository，GitHub API 地址固定为 `api.github.com`。

`GITHUB_TAG_FILE_TOKEN` 必须在 system-service 启动前设置。私有仓库建议使用仅有目标仓库只读 Contents 权限的 Fine-grained Token。
