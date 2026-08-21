// lb.weighted.ts (可选)
import { ServiceInstance } from '@/client/registry-client.options';
import { LoadBalanceStrategy } from './lb.strategy';

export class WeightedStrategy implements LoadBalanceStrategy {
  select(instances: ServiceInstance[]): ServiceInstance | null {
    if (!instances || instances.length === 0) return null;

    const totalWeight = instances.reduce((sum, i) => sum + (i.metadata?.weight ?? 1), 0);
    let rand = Math.random() * totalWeight;

    for (const i of instances) {
      const weight = i.metadata?.weight ?? 1;
      if (rand < weight) return i;
      rand -= weight;
    }
    return instances[0];
  }
}
