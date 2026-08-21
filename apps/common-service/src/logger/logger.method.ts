import { Logger } from '@nestjs/common';

export function LogMethod(): MethodDecorator {
  const logger = new Logger();

  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<any>,
  ) {
    const originalMethod = descriptor.value as (...args: any[]) => Promise<any>;

    descriptor.value = async function (...args: any[]) {
      const className = target.constructor.name;
      const methodName = propertyKey.toString();

      const start = Date.now();
      let result: any;
      let error: any;
      try {
        result = await originalMethod.apply(this, args);
      } catch (err) {
        error = err;
      }
      const end = Date.now();

      const logMessage = {
        class: className,
        method: methodName,
        params: args,
        durationMs: end - start + 'ms',
        ...(error ? { error: error.message || error } : { result }),
      };

      logger.debug(logMessage);

      if (error) {
        throw error;
      }

      return result;
    };

    return descriptor;
  };
}
