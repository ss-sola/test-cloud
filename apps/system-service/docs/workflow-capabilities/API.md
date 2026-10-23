# 独立能力接口

## 公共契约

四个接口均为同源 `POST /api/workflow-capabilities/<能力>`，仅接收 `application/json`，成功使用 `ResponseUtil.success` 包裹 `{code:200,data:…}`，响应 `Cache-Control: no-store`。参数全部由本次请求携带，不读取历史作业、浏览器以外的配置或服务端默认业务范围，不持久化业务数据。

字符串、日期、有限数值、嵌套 runtime、未知字段和矩阵大小均在受约束 DTO/能力边界校验。凭据只放 body，不放 URL/query。示例中的凭据均为占位值，不能写入工作流节点配置或文档。

## 查询 GitHub 提交

`POST /api/workflow-capabilities/github-commits`

```json
{
  "repository": "owner/repository",
  "branch": "main",
  "author": "github-login-or-email",
  "since": "2026-10-12T00:00:00.000Z",
  "until": "2026-10-19T00:00:00.000Z",
  "maxCommits": 100,
  "runtime": {"githubToken": "<本次运行凭据>"}
}
```

repository 也可填写标准 `https://github.com/owner/repository`。since 必须早于 until，跨度不超过 366 天；branch/author 可为空，但仍由本次请求决定。maxCommits 为 1～500，不允许把达到预算后的部分结果静默当完整结果返回。

成功 data 为提交数组：

```json
[
  {
    "hash": "0123456789abcdef0123456789abcdef01234567",
    "author": "developer",
    "date": "2026-10-13T08:00:00.000Z",
    "subject": "实现独立能力节点",
    "body": "提交正文",
    "isMerge": false
  }
]
```

不默认剔除合并提交、非中文或重复内容，不执行摘要和周报编排。远程访问仅固定 GitHub API，失败不返回原始上游响应体。

## AI 文本生成

`POST /api/workflow-capabilities/ai-text`

```json
{
  "prompt": "请根据以下记录生成摘要：…",
  "systemPrompt": "你是严谨的文本助手。",
  "contextWindowTokens": 100000,
  "runtime": {
    "ai": {
      "baseUrl": "http://model-server:8080/v1",
      "apiKey": "<本次运行凭据>",
      "model": "<提供方支持的模型名称>",
      "enableThinking": false
    }
  }
}
```

`runtime.ai.enableThinking` 可选，仅接受严格布尔值（不接受 `null`、字符串或数值）；缺省按 `false` 处理。Token 配置页“启用 AI 思考”默认不勾选，工作流执行时将当前布尔值显式放入 `runtime.ai`。模型客户端每次上游调用（包括长输入分批及归并）都发送 `enable_thinking: input.enableThinking ?? false`；提供方不支持该参数时可能报错，**不会**自动移除参数重试。开启思考可能延长生成或消耗模型自身预算，不改变非流式传输、等待和完整性边界。

成功 data 为 `{ "text": "生成的文本" }`。`contextWindowTokens` 是模型上下文窗口大小，须为 4096～1000000 的整数，默认 100000。新前端每次显式提交；仅为兼容旧直接请求允许缺省，由无状态技术默认值补齐，不读取历史参数。字符串、null、小数和超范围值均不合法。旧版 maxTokens 仅作为可选的废弃兼容字段接收，值完全忽略，不设默认值或数值上限，不替代上下文，也不转发给提供方。

AI 请求不设置应用层主动时限：前端不因等待时长自动中断，后端和传输层只跟随手动停止/客户端断开信号；不是把超时改成一个很大的数。上游服务、浏览器、代理和操作系统仍可能自行报错或断开，不能保证物理连接永久存在。模型与目标地址必须完整提供；不从周报模块补提示词，不做中文检查或本地规则降级。本地不设置最大输出 Token，不向提供方发送 max_tokens、max_completion_tokens 或 max_output_tokens，由模型和提供方采用自身默认行为；它们仍可能有固有上限。prompt 最多 200000 字符，systemPrompt 最多 20000；响应字节/字符预算与完整性检查仍保留。

### 长输入自动分批与归并

- 以 UTF-8 字节数保守估算输入 Token，从窗口中预留 20% 作为生成余量，另扣 256 的消息开销；原 systemPrompt、阶段指令和后续共享要求均计入输入预算。这不是准确 tokenizer，可能提前拆分；估算与预留不保证真实模型上下文或输出长度，也不变成提供方输出 Token 参数。
- 原 prompt 与 systemPrompt 在预算内时仍单次原样调用；超预算时按 Unicode 完整码点无损分片，优先换行，不 trim 或截断。原文所有片段都参与首轮整理，不能只用首尾猜任务。
- 首轮每片须返回严格 JSON `{ "instructions": "该片段出现的任务要求和输出格式原文；无则空串", "content": "保留独立事实的紧凑材料" }`。错误 JSON、字段错误或空结果直接失败，不修补。所有片段的 instructions 按原顺序去重，作为显式共享的 user 上下文传入后续每一轮，不提升到 system 权限；原 systemPrompt 每轮重复。
- 最多 3 批同时在途，按原输入顺序收集而非完成顺序。材料仍超预算时贪心按原序分组归并，不拆单条中间结果；中间归并至少合并两项，单项尾组原样携带且不外呼，每轮结果数必须严格减少。中间轮只整理材料，末轮才生成单一原格式文本；不把多段 JSON 拼接为答案。
- 最多 64 个初始批次、每轮最多 64 批、4 轮归并、128 次总调用，单轮中间结果总字符最多 500000。系统/阶段指令、共享要求或单条中间结果过大、无法收敛或超过执行预算时明确 422，不截断、不空转、不返回部分结果。最终文本原样返回，不新增业务 JSON 校验，格式错误仍由下游 json-parse 拒绝。
- 任一批失败或手动停止/客户端断开，取消其他在途调用并停止领取排队批次与后续轮次，整个节点失败或取消，不向下游分发部分结果。模型客户端将取消 signal 交给 LangChain `invoke` 和底层 Axios HTTP adapter；不等待忽略信号的底层调用，迟到结果不得触发后续外呼。这不保证提供方撤销已经开始的计算。

并发 3 仅限制单次 ai-text 执行，不是工作区执行器并发，也不是跨请求共享额度；本次不新增全局准入、自动重试、持久化、队列或本地降级。所有分片和中间结果只在本次请求内存中处理，不依赖此前请求。

baseUrl 不做额外地址限制：前端原样传递，后端使用 `new URL` 拼接 `/chat/completions`。支持 HTTP/HTTPS、内网域名、单标签域名、IP 和自定义端口，不预查或固定 DNS；URL 的账号与 query 交由 Axios 原生处理，fragment 不进入 HTTP 请求。模型请求使用共享 `AiTextClientService` 调用 LangChain `BaseChatModel.invoke`，由 Axios Node HTTP adapter 发送非流式 Chat Completions；不调用模型 `fetch`，不使用 `ExternalHttpClientService`。HTTPS 证书校验仍由 Node 正常执行，不跟随重定向，不自动使用环境代理；响应解压读取受字节上限约束。该层不提供公网/IP/SSRF 过滤，请自行确认配置目标可信。只接受原始 JSON 响应中非空文本且 `finish_reason === 'stop'` 的结果；空响应、非 stop（含 length 截断）或超预算的生成内容不能作为完整结果向下游返回。模型错误转换为不回显上游正文或凭据的受控异常。输出仅作为文本，不执行其中的代码或指令。

## 飞书查找唯一行

`POST /api/workflow-capabilities/feishu-find-row`

```json
{
  "wikiUrl": "https://tenant.feishu.cn/wiki/resource-token?sheet=sheet-id",
  "range": "A1:B200",
  "matches": [
    {"column":"A","value":"2026-10-12","mode":"contains"},
    {"column":"B","value":"测试人员","mode":"equals"}
  ],
  "runtime": {"appId":"<应用ID>","appSecret":"<本次运行凭据>"}
}
```

支持受约束的飞书 Wiki 或 Sheets HTTPS 地址，必须显式指定 sheet。range 不含 sheetId 或 `!`，查找列为绝对列名且必须落在指定范围内。matches 是明确的有限条件数组，全部条件都满足才匹配，value 必须为字符串；mode 仅 equals/contains。

唯一性仅针对 range，不扩大到整张表，也不因范围外仍有数据就拒绝查找。零匹配与多匹配均报错，不默认取第一行。

合并单元格按区域取值：读取范围值后，再调用飞书 `GET /open-apis/sheets/v2/spreadsheets/:token/metainfo` 读取链接指定工作表的合并区域（0 基 `startRowIndex/startColumnIndex` 与 `rowCount/columnCount`），把区域左上角的值补到区域内每个单元格后再匹配，与表格界面所见一致。例如 A1:A3 合并为同一周时，第 2、3 行的 A 列也视为该周文字。合并区域的左上角若在 range 之外则无法取值，返回 422 `查找范围截断了合并单元格，请扩大范围以包含合并区域的首行和首列。`；链接中的 sheet 不存在返回 400。只用于查找匹配，写入不受影响；所需权限与读取单元格相同。成功 data：

```json
{"wikiUrl":"https://tenant.feishu.cn/wiki/resource-token?sheet=sheet-id","row":9,"sheetId":"sheet-id"}
```

row 为绝对 1 基行号，输出不包含 appSecret 或租户访问 token。查找不内置周报周期、姓名列、工作日或固定输出列。

## 飞书写入单元格

`POST /api/workflow-capabilities/feishu-write-cells`

```json
{
  "wikiUrl": "https://tenant.feishu.cn/wiki/resource-token?sheet=sheet-id",
  "range": "D9:E9",
  "values": [["事项一","事项二"]],
  "confirmed": true,
  "runtime": {"appId":"<应用ID>","appSecret":"<本次运行凭据>"}
}
```

confirmed 必须是严格布尔 true，不能通过字符串隐式转换。前端只在本次即时确认后加入该字段，工作流不保存、导出或恢复确认标记。

values 是矩形二维 string/number/boolean/null，形状必须与 range 一致，范围不含 sheetId/`!`。总预算见 [安全边界](./安全与执行边界.md)；超限拒绝，不截断单格。以 `= + - @`、制表符或回车开头的字符串发送前会添加单引号前缀作文本转义；不把 AI 文本直接拼成公式。该前缀在真实飞书上的显示/求值语义未做外部写入验收，不承诺无前缀显示。相同内容可跳过，不自动重试 PUT，不做追加、插入、删除或格式修改。

成功 data 示例：

```json
{"range":"D9:E9","updatedCells":2,"status":"written"}
```

相同数据跳过时 status 为 skipped，不返回单元格正文。查找和写入是两次独立调用，每次均携带本次凭据和目标，不依赖服务器保留上一次查找结果。

## 失败、取消与重试

- 参数、类型、未知字段或坐标不合法：拒绝处理，不发起相关外呼。
- 超过输入/响应/提交/单元格预算：明确失败，不静默返回残缺结果。
- 查找没有唯一目标：零匹配返回 HTTP 404 与 `指定范围内没有匹配的行。`，多匹配返回 409；均不执行写入。404 在此表示“没有匹配行”，不是接口不存在（未知子路径的 404 文案为 `接口未找到`）。
- 外部服务错误与超时：安全固定文案，不回显密钥、上游响应体、prompt 或 values。
- 工作流前端在节点失败信息中展示服务端返回的受控文案（例如“能力请求失败：指定范围内没有匹配的行。”）；文案缺失、超过 200 字符或包含本次凭据时退回通用提示。
- 停止前端等待不是回滚。写请求已发出后发生超时、断开或取消，远端可能已经写入；需要先核实结果再人工决定是否重跑。

已有 `POST /api/weekly-commit-reports/generate`、`POST /api/weekly-commit-reports/jobs` 与状态接口保持原状，原子节点不调用它们。

## 加载新接口

新增 controller/provider 需要由 Nest 进程重新启动或正常热更新后才会注册。构建复制新静态资源，不等于已经让一个旧的长驻 Node 进程加载新路由。此次保留既有 3500 进程，没有主动停止或重启它；若该进程仍返回新路径 404，应按正常服务启动流程重新加载，再使用远程节点。

## OpenAPI 与 Apifox

[openapi.json](./openapi.json) 是四个独立接口的本地 OpenAPI 3.0 导入文件，不包含真实凭据或运行数据。

导入时先确认当前 Apifox 项目属于 NestCloud/system-service，再选择 OpenAPI 文件导入该项目。本次不在未核实外部项目与发布授权时调用远程写入工具；本地规范和本文是可审查的同步交付物，不声称已经发布到 Apifox。
