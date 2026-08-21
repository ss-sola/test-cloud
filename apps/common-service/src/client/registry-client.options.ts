// client/registry-client.options.ts
export interface RegistryClient {
  registryUrl: string; // 注册中心地址，例如 http://localhost:3000
  serviceName?: string; // 服务名，例如 system-service
  metadata?: Record<string, any>; // 附加信息，例如 { version: "1.0.0" }
  heartbeatInterval?: number; // 心跳间隔，默认 10 秒
  syncInterval?: number; // 本地缓存同步间隔，默认 15s
}

export interface RegistryClientOption extends RegistryClient {
  serviceHost: string; // 服务主机，例如 127.0.0.1
  servicePort: number; // 服务端口，例如 4000
}

export interface ServiceInstance {
  id: string;
  name: string;
  host: string;
  port: number;
  group?: string;
  metadata?: Record<string, any>;
  lastHeartbeat: number;
}
