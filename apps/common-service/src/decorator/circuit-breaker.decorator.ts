import { ProjectException } from '@/exception/global.exception';
import CircuitBreakerLib from 'opossum';

type AsyncOrSync<T> = T | Promise<T>;
type CircuitBreakerOptions = Record<string, unknown>;
type CircuitBreakerMethod<This, Args extends unknown[], Result> = (
  this: This,
  ...args: Args
) => AsyncOrSync<Result>;

interface CircuitBreakerInstance<Result> {
  fallback(handler: () => AsyncOrSync<Result>): void;
  fire(): Promise<Result>;
}

interface CircuitBreakerConstructor {
  new <Result>(
    action: () => AsyncOrSync<Result>,
    options?: CircuitBreakerOptions,
  ): CircuitBreakerInstance<Result>;
}

const CircuitBreaker = CircuitBreakerLib as unknown as CircuitBreakerConstructor;

export function CircuitBreakerDecorator<This, Args extends unknown[], Result>(
  options?: CircuitBreakerOptions,
  fallback?: (this: This, ...args: Args) => AsyncOrSync<Result>,
) {
  return function (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<CircuitBreakerMethod<This, Args, Result>>,
  ) {
    const originalMethod = descriptor.value;

    if (!originalMethod) {
      return descriptor;
    }

    // 每个方法实例化一个 breaker，保证 this 正确
    descriptor.value = function (this: This, ...args: Args): Promise<Result> {
      const breaker = new CircuitBreaker<Result>(() => originalMethod.apply(this, args), options);

      if (fallback) {
        // fallback 会收到原方法参数，this 自动绑定
        breaker.fallback(() => fallback.apply(this, args));
      } else {
        breaker.fallback(() => {
          throw new ProjectException('服务不可用');
        });
      }

      return breaker.fire();
    };

    return descriptor;
  };
}
