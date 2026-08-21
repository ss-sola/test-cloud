import { AsyncLocalStorage } from 'async_hooks';
import { Request, Response } from 'express';
import { ContextExpectation } from '@/exception/global.exception';
import { AccountSessionRequest, CurrentAccountRecord } from '@/system-auth/system-auth.types';

export const asyncLocalStorage = new AsyncLocalStorage<{
  req: AccountSessionRequest;
  res: Response;
}>();

export class ContextService {
  static async setStore({ req, res }: { req: Request; res: Response }, fn: () => void) {
    asyncLocalStorage.run({ req, res }, fn);
  }

  static getReq(): AccountSessionRequest {
    const store = asyncLocalStorage.getStore();
    if (!store) throw new ContextExpectation();
    const req = store.req;
    if (!req) throw new ContextExpectation('请求上下文不存在');
    return req;
  }
  static getRes(): Response {
    const store = asyncLocalStorage.getStore();
    if (!store) throw new ContextExpectation();
    const res = store.res;
    if (!res) throw new ContextExpectation('请求上下文不存在');
    return res;
  }
  static getCurrentAccount() {
    return ContextService.getReq().session.account as CurrentAccountRecord;
  }
}
