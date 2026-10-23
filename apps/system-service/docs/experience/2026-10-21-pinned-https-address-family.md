# Pinned HTTPS 地址族规则误拒绝公网 IPv4

> 历史记录：用户随后明确要求取消请求地址限制，当前代码已移除 Pinned/IP 策略及相关源码，改用 ExternalHttpClientService 直接按域名请求。下文保留的是旧实现的 Node BlockList 失败经验，不代表当前仍有此校验。

## 触发条件与现象

为工作流外部能力实现 DNS 固定连接时，将 IPv4 保留地址和 IPv6 规则放在同一个 Node `net.BlockList` 中，并用 `::ffff:0:0/96` 拒绝 IPv4-mapped IPv6。定向测试发现 `93.184.216.34`、`8.8.8.8` 等公网 IPv4 也被误拒绝，导致连接、重定向、响应大小、取消和超时测试都在真正连接前返回 400。

## 根因

Node BlockList 在地址族间存在映射处理。把 IPv4-mapped IPv6 整段规则放进共用列表，会同时命中以 IPv4 形式传入的地址。不是 DNS 的返回值不可信，也不是普通 IPv4 整数位运算错误。

## 解决

IPv4 与 IPv6 使用两个独立 BlockList，根据 `isIP` 的结果选择相应列表。IPv6 列表继续拒绝 mapped、私网、回环、链路本地等地址；IPv4 列表仅使用对应地址族规则。不能为了让测试通过而移除保留地址限制。

地址预检之外，真正的 HTTPS 连接通过固定 lookup 使用已校验地址，Host/SNI 和证书校验保留原域名；禁止重定向。只做 DNS 预检仍会留下重绑定窗口。

## 历史实现与回归入口

- `src/client/external/ip-address.util.ts`
- `src/client/external/pinned-https-client.service.ts`
- `src/__tests__/workflow-capability-transport.spec.ts`

49 条传输回归覆盖公网地址允许、各类保留地址拒绝、IPv4-mapped IPv6、固定 lookup/Host/SNI、响应预算、重定向、超时和取消。不使用真实外部服务；本地测试 transport 与注入 resolver 保持可控。
