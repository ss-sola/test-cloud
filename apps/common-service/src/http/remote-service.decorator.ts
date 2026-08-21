// remote-service.decorator.ts
import 'reflect-metadata';

const SERVICE_META_KEY = Symbol('REMOTE_SERVICE');

export interface RemoteServiceOptions {
  name?: string;
  url?: string;
  lb?: LB_Type;
  res?: boolean;
}
export enum LB_Type {
  RANDOM,
  ROUND_ROBIN,
}
export function RemoteService(input: string | RemoteServiceOptions): ClassDecorator {
  const options: RemoteServiceOptions = typeof input === 'string' ? { name: input } : input;

  return (target) => {
    Reflect.defineMetadata(SERVICE_META_KEY, options, target);
  };
}

export function getRemoteServiceMeta(target: object) {
  return Reflect.getMetadata(SERVICE_META_KEY, target.constructor) as RemoteServiceOptions;
}
