# 内容对比 API

## 接口清单与输入

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/content-compare/json` | JSON 解析、规范化和结构差异计算 |
| POST | `/api/content-compare/env` | ENV 字符串键值解析和差异计算 |

请求使用 `Content-Type: application/json`，两接口请求体均为完整的 `{ "left": string, "right": string }`；`left` 为页面 A，`right` 为页面 B。每次点击比较或对调都提交当前两侧原文，服务端不读取历史请求或服务端业务默认值。字段必须是原始字符串，数字、数组、对象不隐式转换为字符串。浏览器输入/草稿恢复不触发请求；请求会将原文发送到**本服务**，并非离线计算。

```http
POST /api/content-compare/json
Content-Type: application/json

{"left":"{\"enabled\":true}","right":"{\"enabled\":false}"}
```

Controller 使用 `ResponseUtil.success` 封装 `ContentCompareResult`：

```typescript
interface ContentCompareResult {
  leftText: string;
  rightText: string;
  stats: { added: number; removed: number; modified: number };
  tree: ContentDiffNode;
  segments: { left: DiffSegment[]; right: DiffSegment[] };
}
interface ContentDiffNode {
  key: string | number;
  path: string;
  hasLeft: boolean;
  hasRight: boolean;
  type: 'object' | 'array' | 'value';
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  leftDisplay: string;
  rightDisplay: string;
  children: ContentDiffNode[];
}
interface DiffSegment {
  text: string;
  status: 'added' | 'removed' | 'modified' | null;
}
```

`leftText` / `rightText` 是按侧展示文本，`segments.left` / `segments.right` 是顺序拼接的高亮片段；每侧 `segments` 的 `text` 拼接结果必须等于对应 `leftText` / `rightText`。JSON 成功后，前端直接用服务端返回的规范化文本回填编辑器（文本严格由分段拼接，数字键不再另行序列化）。默认两空格缩进；某侧缩进结果超过 500000 字符时，该侧改为紧凑 JSON，确保可以保存草稿和再次提交；若紧凑文本仍超限，返回 413，不回填。ENV 成功后保留包括 BOM、注释、引号与换行在内的原文；兼容 JSON 对象形式的 ENV 输入时，原文作为未标色片段返回，不以规范化文本覆盖原文。

`stats` 统计差异数量；`tree` 按路径和状态组织节点，`hasLeft` / `hasRight` 区分缺失与存在（包括 `null`）。`leftDisplay` / `rightDisplay` 是本侧可直接显示的值：对象/数组只显示本层容器计数，不包含整个子树原文，即使两侧数据类型不同也一样；前端不依据树重新计算文本。

## 失败协议

解析两侧后统一给出按侧错误；业务解析失败返回 HTTP 400，并在 `ResponseUtil.error` 标准封装之外携带 `errors: { left: CompareParseError[], right: CompareParseError[] }`：

```typescript
interface CompareParseError {
  code: string;
  message: string;
  line?: number;
  column?: number;
  previousLine?: number;
}
```

`line`、`column` 及 `previousLine`（例如重复 ENV 键首次出现的行号）仅在适用时提供。错误文案不包含输入原文、键值、JSON 片段；按侧错误最多各 100 条。字段类型/格式校验、结构或输出预算超限也受控拒绝（按错误类型返回 400/413），不可依赖原文出现在错误响应；请求体解析失败、方法/子路径/Content-Type 不支持等由路由专用边界处理。页面在 HTTP 400 时按侧显示可用错误；413、网络失败、30 秒前端超时及其他异常显示通用错误并保留输入，用户可重试，不降级为本地计算。

## 资源及缓存约束

每侧原文最多 **500000 UTF-16 字符**，结构深度最多 **64**、节点最多 **10000**（每侧），路径最多 **4096 字符**；路由专用 JSON 请求体上限 **6 MiB**、结果上限 **8 MiB**。构建路径、显示值和分段时可依据保守输出预算提前拒绝，不能假设只在最终序列化后才检测。两个路由响应设置 `Cache-Control: no-store`；后端不持久化、不缓存、不外发原文或结果。算法及日志边界见 [实现与边界](./实现与边界.md)。
