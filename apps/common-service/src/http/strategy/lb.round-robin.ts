// lb.round-robin.ts
import { ServiceInstance } from '@/client/registry-client.options';
import { LoadBalanceStrategy } from './lb.strategy';

export class RoundRobinStrategy implements LoadBalanceStrategy {
  private counters = new Map<string, number>();

  select(instances: ServiceInstance[], key: string = 'default'): ServiceInstance | null {
    if (!instances || instances.length === 0) return null;

    const counter = this.counters.get(key) ?? 0;
    const instance = instances[counter % instances.length];
    this.counters.set(key, counter + 1);
    return instance;
  }
}
