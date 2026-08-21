// lb.random.ts
import { ServiceInstance } from '@/client/registry-client.options';
import { LoadBalanceStrategy } from './lb.strategy';

export class RandomStrategy implements LoadBalanceStrategy {
  select(instances: ServiceInstance[]): ServiceInstance | null {
    if (!instances || instances.length === 0) return null;
    return instances[Math.floor(Math.random() * instances.length)];
  }
}
