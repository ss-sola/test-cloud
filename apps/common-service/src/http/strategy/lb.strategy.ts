// lb.strategy.ts

import { ServiceInstance } from '@/client/registry-client.options';

export interface LoadBalanceStrategy {
  select(instances: ServiceInstance[], key?: string): ServiceInstance | null;
}
