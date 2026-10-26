# 工作流执行 API

## 范围与准入

基础路径 `/api/workflow`（部署全局前缀时按服务配置添加）；与固定 JSON 文件的 `/api/workflow-directory` **不同**。五个端点均为本次请求驱动的单进程短时任务，成功返回 `ResponseUtil.success` 包装的 `{ "code": 200, "message": "...", "data": ... }`，错误返回相应 HTTP 状态及受控 `{code,message,...}`，禁用缓存。POST 只接受 `Content-Type: application/json`，严格拒绝多余字段、错误类型与不受支持的方法；浏览器跨源请求被拒绝。所有任务参数由创建请求提交，不读取文件路径、历史请求、数据库、Redis 或服务器保存的凭据。

**`POST /run` 没有用户登录认证，也不需要任务 token。** 仅应在可信网络开放；面向不可信调用方须由网关实施认证、限流与出口控制，尤其要审查可指向内网的 AI `baseUrl`。同源/Origin 检查和任务 token 不构成创建入口的访问控制。创建后 `runId` 仅是资源标识，不是权限；`status/events/stop/confirm` 一律在 **`X-Workflow-Token` 请求头**提供启动响应中的 `accessToken`，绝不能放在 query、URL、日志或文档中。持有者可以读完整结果、停止任务并决定飞书写入；转交 token 即委托这些权限，`accepted: true` 不能证明由真人审核。非浏览器客户端也须由可信网关约束。

## 接口清单

| 方法 | 路径 | 参数 | 成功 `data` |
|---|---|---|---|
| POST | `/run` | JSON `{document,runtime,dateContext?,fromNodeId?,previousOutputs?}` | `{runId,accessToken,expiresAt}` |
| GET | `/status?runId=…&nodeId=…` | `nodeId` 可选，专用 token 头 | 当前快照，完整输出 |
| GET | `/events?runId=…` | 专用 token 头，`Accept: text/event-stream` | SSE，首帧快照、后续状态增量 |
| POST | `/stop` | JSON `{runId}`，专用 token 头 | 当前快照（含输出） |
| POST | `/confirm` | JSON `{runId,confirmationId,accepted}`，专用 token 头 | 已记录决定后的快照（不含输出） |

`runId` 与 `confirmationId` 为服务端 UUID；`accessToken` 为一次性交付的随机令牌。`expiresAt`、快照的 `startedAt/finishedAt/expiresAt`、确认的 `expiresAt` 均为 Unix 毫秒时间戳；`finishedAt` 运行中为 `null`。所有 query 资源标识均为参数而非路径片段。POST 不带 query；GET 不带正文。错误的 token、未知 runId、已过期任务和无效 nodeId 均以 404 隐去差别；过时、已消费或重复确认返回 409。输入/文档错误 400，跨源 403，不支持的方法 405、媒体类型 415，预算超限 413，任务或订阅额度满 429，服务关闭 503；内部失败返回受控信息，不回显密钥或请求原文。

### 启动与显式输入

`document` 必传，**类型是完整工作流 JSON 的字符串**，不是嵌套对象，也不是服务器文件名或目录路径；文档格式参见[节点扩展](./节点扩展.md)。`runtime` 必传，可以为 `{}`；可选字段：`githubToken`、`ai:{baseUrl,apiKey,model,enableThinking?}`、`feishuAppId`、`feishuAppSecret`。开始节点若配置某组凭据则整组优先，否则使用本次 runtime 对应组；不跨来源拼凑缺项。无日期节点的执行可省略 `dateContext`；执行范围内**有日期范围节点必须提供** `{ "now": "2026-10-23T10:00:00.000Z", "timeZone": "Asia/Shanghai" }`。`now` 是带时区的完整 ISO 日期时间，`timeZone` 是有效 IANA 时区；计算当地周界和夏令时不使用服务端本地时区。页面点击运行时冻结当前 `new Date().toISOString()` 与浏览器 `Intl.DateTimeFormat().resolvedOptions().timeZone`，连同当次文档和凭据一起提交；直接调用者须自行显式冻结这组输入。

整图请求不携带旧结果；局部重跑时 `fromNodeId` 和 `previousOutputs` **成对出现**，即使无需复用也显式传 `[]`。`previousOutputs` 为 `[{"nodeId":"上游节点ID","outputs":{"声明的输出端口":值}}]`，只包含本次执行范围外、确需复用的已成功 task 上游；被动数据与开始节点在本次重新求值，不能用旧任务 ID 代替。执行核心逐节点校验端口、类型、结构、复用范围与数量；多余、缺失、重复、范围内的旧输出都拒绝。服务端对本次请求创建独立 Workspace，复用同一份无 DOM 核心、注册定义与依赖调度，不从上次服务端任务读取结果。页面“从此节点运行”从本页未失效的成功输出组装这一数组。

启动响应只说明任务已创建，**不是执行完成**；收到响应后应保存 token 于调用方受控内存并查询状态。启动响应丢失时服务端可能已创建孤儿任务；没有 token 无法查它，客户端不得自动重发 `/run`（可能重复远端副作用），由 TTL 清理。浏览器不持久保存执行 token、状态或结果；外部调用方如需在 TTL 内继续访问须自行安全保管 token，并自行保存所需结果，不把本服务当作结果档案。

### 状态、输出与事件

状态快照形状（示意，消息/节点按实际运行变化）：

```json
{
  "runId": "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx",
  "revision": 3,
  "running": true,
  "status": "running",
  "startedAt": 1792730400000,
  "finishedAt": null,
  "expiresAt": 1792737600000,
  "states": [{ "nodeId": "result", "status": "succeeded", "message": "", "outputs": {"text": "示例"} }],
  "confirmations": []
}
```

`GET /status?runId=…` 返回本任务的完整 `states` 及 `outputs`（失败/排队为 `null`）：整图运行包含范围外的 skipped，局部重跑包含本次执行节点及显式复用的边界上游，不重新带回无关分支的旧结果；指定 `nodeId` 则只返回该节点，快照其余元信息仍在。节点状态可为 `queued/running/succeeded/failed/skipped/cancelled`；运行汇总状态为 `running/succeeded/partial/failed/cancelled`。待确认 `confirmations` 为数组，每项含 `{confirmationId,nodeId,nodeName,wikiUrl,range,values,expiresAt}`。`revision` 是**每个任务全局递增**的状态版本，不是每个节点单独计数；查询、重连和心跳都不续期。

SSE 的 `Content-Type: text/event-stream`，事件类型为 `snapshot`、`node-state`、`confirmations`、`run-finished`，帧 `id` 为 revision、`data` 为 JSON 快照（**不**经 `ResponseUtil` 包装）。订阅时同步发送当前 `snapshot`，`states` 含当前所有节点但**不含 `outputs`**；之后 `node-state` 只带发生变化的节点状态，`confirmations` 带当前待确认数组，`run-finished` 带终态状态，事件均不含完整输出。确认变化帧可能含空 `states`；每 15 秒 `: ping` 注释心跳不推进 revision。节点成功后以及终态应调用 `status` 获取输出，不能只凭 SSE 宣称已有完整结果。重连得到**最新快照**，没有事件历史重放；`Last-Event-ID` 不作续传依据，客户端按 revision 忽略旧增量，断线时主动查询 status 补齐。关闭 SSE 仅退订，后台继续；显式 `/stop` 才尝试停止任务。

### 停止与逐次确认

`POST /stop` 为显式、幂等的任务停止；**只有收到成功响应才能当作停止已被服务端处理**。超时/网络失败时任务可能还在运行，先继续查询或重新发送 stop，不把本地断线或弹窗关闭显示为“已取消”。停止阻断后续调度并请求取消底层调用，不保证撤销已提交远端写入；相关节点保留“远端可能已写入”提示，应先核实目标再决定是否重跑。

飞书写入节点根据**本次运行中实际生成的** `wikiUrl/range/values` 创建一次性 `confirmationId`，最多同时存在 3 个独立待确认项。先从 `status` 或 SSE 读取有界矩阵并人工核对目标和内容，再 `POST /confirm`：`accepted` 必须是布尔值（拒绝为 `false`，不是字符串）。拒绝、10 分钟确认期限到达、任务停止/过期都不授权写入；确认期限还受任务绝对 deadline 约束。ID 在接受/拒绝时原子消费，重放或旧 ID 为 409；接受后节点重新争取执行槽并再次检查停止/期限。confirm 成功**只代表决定已记录**，不保证写入成功；后续查节点状态和结果。文档里的 `confirmed:true` 不构成任务写入授权。页面现有模态窗口串行展示这些独立确认，不能以隐藏弹窗替代拒绝请求。写入已发出时取消仍可能有远端副作用。

## 容量、期限与部署

| 资源 | 已实现边界 |
|---|---|
| 请求 | `/run` JSON 正文总计 64 MiB；`document` UTF-8 最多 4 MiB；`previousOutputs` 最多 100 项、32 MiB、嵌套深度 160；`/stop`、`/confirm` 各 4 KiB 正文 |
| 任务与内存 | 最多 3 个活动任务、20 个保留任务；活动任务预留容量与结果占用总计最多 128 MiB；节点结果每工作区最多 32 MiB；额度不足拒绝新任务，不驱逐有效结果 |
| 并发 | 全服务共享 3 个在途节点执行器（FIFO，无公平性保证）；真实能力调用最多 9 在途、27 排队，包括 AI 的每次实际模型 client 调用；单次 AI 自身最多 3 批并行 |
| 有效期 | 活动任务创建起绝对 2 小时上限（AI 原子调用自身仍无主动截止）；终态结果保留 15 分钟；确认等待最多 10 分钟且不超过任务期限；每 30 秒及授权访问时清理 |
| SSE | 每 run 至多 4 个订阅，全局至多 12 个；心跳 15 秒；慢消费者写缓冲阻塞时仅保留当前一帧，下一帧/心跳到来仍阻塞则断开订阅，客户端以最新快照恢复 |

停止、过期或关闭导致逻辑终态，不等于忽略取消的原始网络调用已结清：对应调用额度和预留内存仍记账直到原始 Promise 结束，即使结果记录随后过期亦然。所有状态、凭据与结果只在**单进程短时内存**，正常关闭会请求取消；服务重启/硬退出即丢失状态，不支持恢复。多实例部署需同一任务后续请求走原实例（粘性路由）；粘性路由不提供共享内存或故障恢复。固定 `public/workflow/` JSON 读写是独立且唯一的文件例外，不存任务状态或输出。

## 可控本地示例（不接外部网络）

在可信的本地 system-service 已加载新路由后运行以下命令；示例只执行开始、被动文本和文本结果节点，`runtime` 为空，不连接 GitHub、AI、飞书。把 `$BASE` 按实际服务地址设置，不将示例 token 写入文件或历史；以下示意用手工复制 `/run` 返回的 `data.runId` 和 `data.accessToken` 到当前 shell 变量。不要对不可信公开服务执行此示例。

```bash
BASE='http://127.0.0.1:3500'
node - <<'NODE' | curl -fsS "$BASE/api/workflow/run" -H 'Content-Type: application/json' --data-binary @-
const node = (id, type, config, x, y) => ({ id, type, version: 1, name: id,
  position: { x, y }, size: { width: 320, height: 280 }, config })
const document = { version: 1, id: 'local-example', name: '本地示例', viewport: { x: 24, y: 24, zoom: 1 },
  nodes: [node('entry', 'start', {}, 0, 0), node('text', 'text', { text: 'hello' }, 0, 300),
    node('result', 'text-result', { format: 'text' }, 400, 0)],
  edges: [
    { id: 'edge-1', source: { nodeId: 'entry', port: 'trigger' }, target: { nodeId: 'result', port: 'trigger' } },
    { id: 'edge-2', source: { nodeId: 'text', port: 'text' }, target: { nodeId: 'result', port: 'text' } },
  ] }
process.stdout.write(JSON.stringify({ document: JSON.stringify(document), runtime: {} }))
NODE
# 手工将启动响应 data 的两个字段填入以下变量（切勿填入 URL）：
RUN_ID='<data.runId>'
TOKEN='<data.accessToken>'
curl -fsS "$BASE/api/workflow/status?runId=$RUN_ID" -H "X-Workflow-Token: $TOKEN"
# 按需监听事件；结束时 SSE 服务端自动关闭，不会重放历史事件：
curl -N "$BASE/api/workflow/events?runId=$RUN_ID" -H "X-Workflow-Token: $TOKEN" -H 'Accept: text/event-stream'
# 对仍在运行的任务显式停止；此纯本地样例通常已快速结束：
curl -fsS "$BASE/api/workflow/stop" -H 'Content-Type: application/json' -H "X-Workflow-Token: $TOKEN" -d "{\"runId\":\"$RUN_ID\"}"
```

如需调用确认接口，只对 `status.data.confirmations` 中**真实存在且尚未过期**的 `confirmationId` 提交 `{"runId":"…","confirmationId":"…","accepted":false}` 以拒绝；本地示例不会产生确认。不要用演示值或真实飞书地址发 `accepted:true`。单元/HTTP/浏览器受控测试入口见[执行与存储](./执行与存储.md#验证入口)。本地规范不向 Apifox 或其他外部服务发布。
