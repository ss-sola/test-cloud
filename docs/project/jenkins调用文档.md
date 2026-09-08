# Jenkins 流水线接口调用文档

> 来源：Apifox 项目「本地测试」
>
> - 项目 ID：`6343347`
> - 分支：`main`（分支 ID：`6038882`）
> - 目录：`jenkins`（目录 ID：`94979940`）
> - 接口数量：4
> - 整理时间：2026-09-04
>
> 本文按照该目录当前保存的 Apifox 定义整理。接口地址使用内网 Jenkins 地址，仅适用于能够访问 `192.168.88.223:8080` 的网络环境。

## 1. 调用流程

```text
触发流水线
    │
    ├─ 获取本次触发对应的队列项 ID
    │
    ▼
查询队列
    │
    ├─ 从 executable.number 获取构建 ID
    │
    ▼
构建状态（将路径中的 {id} 替换为构建 ID）
```

当前 Apifox 没有记录“触发流水线”响应中的队列 ID 获取方式，也没有把查询队列接口配置成动态路径参数。提供的实际队列响应中，队列项 ID 为 `1365`，构建编号为 `executable.number = 1898`；这与 Apifox 当前路径中固定的 `1896` 不一致。实际调用应以本次触发后得到的队列项 ID 为准。

## 2. 公共配置

建议通过环境变量传入 Jenkins token，服务端固定使用用户名 `root` 组装 Basic Auth，不要把 token 或 `Authorization` 值硬编码到脚本、代码仓库或日志中。

```bash
export JENKINS_BASE_URL="http://192.168.88.223:8080"
export JENKINS_TOKEN="<jenkins-token>"
export BUILD_BRANCH="merge/wzj-temp"
export BUILD_PLATFORM="x86-debian"
export BUILD_SKIP_TEST="false"
```

- `JENKINS_TOKEN` 仅使用占位符表示；实际值请从安全配置读取，服务端按 `root:<JENKINS_TOKEN>` 生成 Basic Auth。
- Apifox 中 `token`、`branch`、`platform`、`skipTest` 均标记为非必填。
- 请求头 `Authorization` 不直接由调用方填写，服务端统一生成 `Basic base64(root:<jenkins-token>)`。

## 3. 接口详情

### 3.1 触发流水线

**接口 ID：** `510433341`

**方法与地址：**

```http
POST http://192.168.88.223:8080/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/buildWithParameters
```

#### 请求参数

| 参数名 | 位置 | 类型 | 必填 | 示例 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `token` | Query | string | 否 | `<jenkins-token>` | Jenkins 触发 token |
| `branch` | Query | string | 否 | `merge/wzj-temp` | 构建分支 |
| `platform` | Query | string | 否 | `x86-debian` | 构建平台 |
| `skipTest` | Query | boolean | 否 | `false` | 是否跳过测试，传 `true` 或 `false` |
| `Authorization` | Header | string | 自动生成 | `Basic base64(root:<jenkins-token>)` | 服务端使用 root 用户和 Jenkins token 生成；不要写入源码或日志 |

请求体：无（`none`）。

#### curl 示例

```bash
curl --fail-with-body --request POST \
  --url "${JENKINS_BASE_URL}/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/buildWithParameters" \
  --get \
  --data-urlencode "token=${JENKINS_TOKEN}" \
  --data-urlencode "branch=${BUILD_BRANCH}" \
  --data-urlencode "platform=${BUILD_PLATFORM}" \
  --data-urlencode "skipTest=${BUILD_SKIP_TEST}" \
  --user "root:${JENKINS_TOKEN}"
```

> `--get` 让 curl 将 `--data-urlencode` 参数放入查询字符串；请求方法仍由 `--request POST` 指定。

#### 响应

Apifox 当前仅定义：

- HTTP 状态：`200`
- `Content-Type`：`application/json`
- 响应结构：空对象 `{}`

未定义队列 ID、`Location` 响应头或错误响应结构。调用方不能仅依赖当前 Apifox schema 判断 Jenkins 是否返回了可继续查询的队列信息。

---

### 3.2 查询队列

**接口 ID：** `510436062`

**方法与地址（当前 Apifox 定义）：**

```http
GET http://192.168.88.223:8080/queue/item/1896/api/json
```

该接口没有请求参数，也没有请求体。队列编号 `1896` 已被直接写入路径。

#### curl 示例：按当前 Apifox 地址调用

```bash
curl --fail-with-body --request GET \
  --url "${JENKINS_BASE_URL}/queue/item/1896/api/json"
```

#### curl 示例：查询实际队列项

如果实际队列 ID 不是 `1896`，请在调用时替换路径中的 `<queue-id>`。这只是 Jenkins 实际调用形式，当前 Apifox 接口仍然是固定 `1896` 的定义。

```bash
export JENKINS_QUEUE_ID="<queue-id>"

curl --fail-with-body --request GET \
  --url "${JENKINS_BASE_URL}/queue/item/${JENKINS_QUEUE_ID}/api/json"
```

#### 响应

Apifox 当前仅定义：

- HTTP 状态：`200`
- `Content-Type`：`application/json`
- 响应结构：空对象 `{}`

你提供的实际响应示例（队列项已离开队列，并已分配构建任务）如下：

```json
{
  "_class": "hudson.model.Queue$LeftItem",
  "actions": [
    {
      "_class": "hudson.model.ParametersAction",
      "parameters": [
        {
          "_class": "hudson.model.StringParameterValue",
          "name": "branch",
          "value": "merge/wzj-temp"
        },
        {
          "_class": "hudson.model.StringParameterValue",
          "name": "platform",
          "value": "x86-debian"
        },
        {
          "_class": "hudson.model.BooleanParameterValue",
          "name": "skipTest",
          "value": true
        }
      ]
    },
    {
      "_class": "hudson.model.CauseAction",
      "causes": [
        {
          "_class": "hudson.model.Cause$RemoteCause",
          "shortDescription": "Started by remote host 192.168.89.89",
          "addr": "192.168.89.89",
          "note": null
        }
      ]
    }
  ],
  "blocked": false,
  "buildable": false,
  "id": 1365,
  "inQueueSince": 1788424117637,
  "params": "\\nbranch=merge/wzj-temp\\nplatform=x86-debian\\nskipTest=true",
  "stuck": false,
  "task": {
    "_class": "org.jenkinsci.plugins.workflow.job.WorkflowJob",
    "name": "wzj-nodejs-v2",
    "url": "http://192.168.88.223:8080/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/",
    "color": "blue"
  },
  "url": "queue/item/1365/",
  "why": null,
  "cancelled": false,
  "executable": {
    "_class": "org.jenkinsci.plugins.workflow.job.WorkflowRun",
    "number": 1898,
    "url": "http://192.168.88.223:8080/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/1898/"
  }
}
```

#### 关键字段

| 字段 | 示例值 | 说明 |
| --- | --- | --- |
| `id` | `1365` | Jenkins 队列项 ID |
| `executable.number` | `1898` | 已分配的构建编号；传给“构建状态”接口的 `{id}` |
| `executable.url` | `.../1898/` | 构建详情地址 |
| `blocked` | `false` | 队列项是否被阻塞 |
| `buildable` | `false` | 队列项当前是否可构建 |
| `stuck` | `false` | 队列项是否处于卡住状态 |
| `cancelled` | `false` | 队列项是否已取消 |
| `actions[].parameters` | branch/platform/skipTest | 本次构建实际使用的参数 |
| `task.name` | `wzj-nodejs-v2` | Jenkins 任务名称 |
| `why` | `null` | 排队原因说明；无原因时为 `null` |

本次示例的调用链为：

```text
查询队列项 ID 1365
    └─ executable.number = 1898
         └─ GET /job/.../wzj-nodejs-v2/1898/api/json
```

如果响应中的 `executable` 为 `null`，当前还没有可用的构建编号，应继续轮询队列接口；如果 `cancelled` 为 `true`，则不应继续查询构建状态。

现有 Apifox 响应示例名称为“未找到”，示例内容是 Jenkins 的 HTML 404 页面，而不是 JSON 成功响应。队列 ID 失效或不正确时，应按 Jenkins 实际 HTTP 状态处理，不要把 404 HTML 当成成功业务数据。

---

### 3.3 构建状态

**接口 ID：** `510441510`

**方法与地址：**

```http
GET http://192.168.88.223:8080/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/{id}/api/json
```

#### 路径参数

| 参数名 | 位置 | 类型 | 必填 | 示例 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | Path | string | 是 | `1898` | Jenkins 构建编号 |

请求体：无。

#### curl 示例

```bash
export JENKINS_BUILD_ID="1898"

curl --fail-with-body --request GET \
  --url "${JENKINS_BASE_URL}/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/${JENKINS_BUILD_ID}/api/json"
```

#### 响应

Apifox 当前仅定义：

- HTTP 状态：`200`
- `Content-Type`：`application/json`
- 响应结构：空对象 `{}`

你提供的实际成功响应包含 Jenkins 插件扩展字段。下面保留调用方最需要的核心字段；`actions` 中其他插件对象、各分支历史构建记录和空对象未全部展开：

```json
{
  "_class": "org.jenkinsci.plugins.workflow.job.WorkflowRun",
  "actions": [
    {
      "_class": "hudson.model.ParametersAction",
      "parameters": [
        {
          "_class": "hudson.model.StringParameterValue",
          "name": "branch",
          "value": "merge/wzj-temp"
        },
        {
          "_class": "hudson.model.StringParameterValue",
          "name": "platform",
          "value": "x86-debian"
        },
        {
          "_class": "hudson.model.BooleanParameterValue",
          "name": "skipTest",
          "value": true
        }
      ]
    },
    {
      "_class": "jenkins.metrics.impl.TimeInQueueAction",
      "blockedDurationMillis": 0,
      "blockedTimeMillis": 0,
      "buildableDurationMillis": 7,
      "buildableTimeMillis": 7,
      "buildingDurationMillis": 26755,
      "executingTimeMillis": 26490,
      "executorUtilization": 0.99,
      "subTaskCount": 1,
      "waitingDurationMillis": 5346,
      "waitingTimeMillis": 5346
    },
    {
      "_class": "hudson.plugins.git.util.BuildData",
      "lastBuiltRevision": {
        "SHA1": "d16ae737294f3e900037c2300381e7896f143b40",
        "branch": [
          {
            "SHA1": "d16ae737294f3e900037c2300381e7896f143b40",
            "name": "refs/remotes/origin/merge/wzj-temp"
          }
        ]
      },
      "remoteUrls": [
        "git@github.com:whtthd/wzj-nodejs-v2.git"
      ],
      "scmName": ""
    }
  ],
  "artifacts": [],
  "building": false,
  "description": null,
  "displayName": "#1898",
  "duration": 26755,
  "estimatedDuration": 116638,
  "executor": null,
  "fullDisplayName": "微助教 » wzj-nodejs-v2 #1898",
  "id": "1898",
  "keepLog": false,
  "number": 1898,
  "queueId": 1365,
  "result": "SUCCESS",
  "timestamp": 1788424122983,
  "url": "http://192.168.88.223:8080/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/1898/",
  "changeSets": [],
  "culprits": [],
  "inProgress": false,
  "nextBuild": null,
  "previousBuild": {
    "number": 1897,
    "url": "http://192.168.88.223:8080/job/%E5%BE%AE%E5%8A%A9%E6%95%99/job/wzj-nodejs-v2/1897/"
  }
}
```

#### 关键字段

| 字段 | 示例值 | 说明 |
| --- | --- | --- |
| `id` / `number` | `1898` | Jenkins 构建编号，也是路径中的 `{id}` |
| `result` | `SUCCESS` | 构建结果；构建未结束时通常为空 |
| `building` / `inProgress` | `false` / `false` | 是否仍在构建或处理中 |
| `queueId` | `1365` | 对应查询队列接口返回的队列项 ID |
| `displayName` | `#1898` | Jenkins 展示名称 |
| `duration` | `26755` | 已耗时，单位为毫秒 |
| `estimatedDuration` | `116638` | 预计耗时，单位为毫秒 |
| `actions[].parameters` | branch/platform/skipTest | 本次构建实际使用的参数 |
| `actions[].TimeInQueueAction` | 多个毫秒字段 | 排队、构建和执行耗时统计 |
| `actions[].BuildData.lastBuiltRevision` | SHA1 + branch | 本次构建使用的 Git 提交和分支 |
| `actions[].BuildData.remoteUrls` | GitHub 仓库地址 | 构建关联的代码仓库 |
| `artifacts` | `[]` | 构建产物列表；本次示例为空 |
| `previousBuild.number` | `1897` | 上一次构建编号 |

上述响应字段来自实际构建示例；当前 Apifox schema 仍未正式声明这些字段，也没有声明 `result` 的完整枚举。`actions` 数组可能包含空对象或 Jenkins 插件追加的扩展对象，解析时应按字段存在性兼容处理。

常见状态判断建议：

```text
building = true 或 inProgress = true  → 构建尚未结束，继续轮询
building = false 且 result = SUCCESS   → 构建成功
building = false 且 result 有其他值    → 构建已结束但未成功，按 result 处理
result 为空                             → 构建结果尚未产生，继续查询
HTTP 404                                → 构建编号不存在或地址不正确
```

---

### 3.4 完整 Pipeline

**接口 ID：** `510443076`

**方法：** `GET`

**路径：** 未配置（空字符串）

**请求参数：** 无

**响应定义：** HTTP `200`、`application/json`、空对象 `{}`

当前接口没有可用 URL，因此无法生成可执行的 curl 调用。请先在 Apifox 中补充：

1. 完整的请求路径；
2. 是否需要 Query、Header 或 Path 参数；
3. 成功响应和错误响应结构；
4. 如用于查询完整流水线，明确其与 Jenkins 任务、队列项或构建编号的对应关系。

## 4. 调用注意事项

1. **内网访问**：所有地址均指向 `192.168.88.223:8080`，调用机器必须具备对应网络可达性。
2. **鉴权安全**：不要提交真实 Jenkins token、Authorization 值或其他凭据；日志中也应避免打印完整请求 URL 和请求头。
3. **队列 ID 动态性**：查询队列接口当前固定为 `/queue/item/1896/api/json`，复用时应替换为本次触发对应的队列 ID。
4. **构建 ID 动态性**：构建状态接口的 `{id}` 必须替换为实际构建编号，示例链路中为 `1898`。
5. **响应 schema 不完整**：前三个接口的响应 schema 都是空对象；业务代码应以 Jenkins 实际返回为准，并自行处理非 200 响应。
6. **“完整 Pipeline”不可调用**：在 Apifox 补齐路径和响应定义前，不应将其用于自动化流程。
