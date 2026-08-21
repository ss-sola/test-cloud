import { AuthDenied } from '@/exception/global.exception';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AccountSessionRequest } from '../system-auth.types';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AccountSessionRequest>();
    if (!request.session?.account) {
      throw new AuthDenied('请先登录');
    }
    return true;
  }
}
