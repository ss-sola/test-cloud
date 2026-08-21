import { Type } from '@nestjs/common';

const MARK_KEY = Symbol('EnableConfigCenter');

export function EnableConfigCenter() {
  return (target: Type<unknown>) => {
    Reflect.defineMetadata(MARK_KEY, true, target);
  };
}
export function enableConfigCenter(target: object) {
  return Reflect.hasMetadata(MARK_KEY, target);
}
