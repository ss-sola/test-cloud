# LangChain 兼容模型的超时与追踪边界

## 问题与触发条件

将现有 OpenAI-compatible 模型调用改为 LangChain 时，直接使用 `ChatOpenAI` 会引入提供方 SDK 的默认行为，不能仅用 `timeout: 0`、`useResponsesApi: false` 或空 callbacks 推断原有契约仍成立。

2026-10-22 在本项目中核对过 `@langchain/openai@1.6.3`、`@langchain/core@1.2.20` 及其解析到的 `openai@7.39.0`：

- OpenAI SDK 省略 timeout 时使用 600000 毫秒默认值；timeout 为零会建立零延迟取消计时器，不表示无限等待。请求级 null/undefined 也不是受支持的关闭方式。
- ChatOpenAI 的 Responses 路由还依据模型和工具决定；仅传 `useResponsesApi: false` 不能保证所有模型始终使用 Chat Completions。
- 标准 LangSmith 跟踪可能由环境开启；仅传 `callbacks: []` 不足以关闭。
- ChatOpenAI 没有与原有读取过程等价的响应字节硬上限参数。

这些结论通过已安装源码、离线配置及本机模拟响应确认，未调用真实计费模型。

## 本项目处理

统一使用 `AiTextClientService`，其模型适配器继承 LangChain 官方 `BaseChatModel`，业务通过 `model.invoke` 调用。适配器使用 Axios 的 Node HTTP adapter，而不是重新引入模型 fetch：

- `adapter: 'http'`，明确不选择 Axios fetch adapter。
- `timeout: 0` 在 Axios 中表示无主动截止；旧周报显式传入的 `timeoutMs` 由客户端转换为取消信号，工作流只跟随调用方信号。
- `maxRedirects: 0`、`maxContentLength` 和 `proxy: false` 保留禁止跳转、解压读取字节预算及直连本次指定地址。
- 非流式 Chat Completions，固定使用请求中的模型，不自动切换 Responses，不设置输出 Token 上限；关闭缓存与自动重试。
- 标准跟踪使用 `langsmith/traceable` 的 `tracingEnabled: false` 执行上下文，加空 callbacks 关闭，不修改进程环境。该机制不承诺屏蔽其他代码自行注册的任意全局 callback 插件。

已移除临时研究用的 `@langchain/openai` 直接依赖及旧模型 fetch 客户端。GitHub/飞书的既有 HTTP 路径不属于此次替换范围。

## 验证要点

通过实际 `BaseChatModel.invoke` 链路验证消息和凭据；把全局 fetch 设为失败桩仍可成功生成。使用虚拟时钟等待超过十分钟确认无隐式截止，验证显式周报截止与手动取消。用本机 HTTP 模型检查 query/fragment、重定向拒绝，以及压缩体较小但解压后超预算时中断读取。

后续升级 LangChain、Axios 或 LangSmith 时，应重新验证这些边界，不能把不同库对 timeout 为零的解释混用。
