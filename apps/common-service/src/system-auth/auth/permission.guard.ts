import { AuthDenied } from '@/exception/global.exception';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import {
  REQUIRED_PERMISSION_CODES_KEY,
  REQUIRED_PERMISSION_MATCH_MODE_KEY,
  RequiredPermissionMatchMode,
} from './require-permissions.decorator';
import { ContextService } from '@/context/context.service';

@Injectable()
export class PermissionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permissionCodes = this.getRequiredPermissionCodes(context);
    if (!permissionCodes.length) {
      return true;
    }

    const currentAccount = ContextService.getCurrentAccount();
    if (!currentAccount) {
      throw new AuthDenied('请先登录');
    }

    const userPermissionCodes = currentAccount.permissionCodes;
    if (!userPermissionCodes || userPermissionCodes.length === 0) {
      throw new AuthDenied('无权限信息，请重新登录');
    }

    const userPermissionSet = new Set(userPermissionCodes);
    const missingPermissionCodes = permissionCodes.filter((code) => !userPermissionSet.has(code));

    if (this.isPermissionAllowed(context, permissionCodes, missingPermissionCodes)) {
      return true;
    }

    throw new AuthDenied(`缺少权限：${missingPermissionCodes.join(', ')}`);
  }

  private isPermissionAllowed(
    context: ExecutionContext,
    permissionCodes: string[],
    missingPermissionCodes: string[],
  ): boolean {
    const matchMode = this.getRequiredPermissionMatchMode(context);
    if (matchMode === 'any') {
      return missingPermissionCodes.length < permissionCodes.length;
    }
    return missingPermissionCodes.length === 0;
  }

  private getRequiredPermissionCodes(context: ExecutionContext): string[] {
    return (
      Reflect.getMetadata(REQUIRED_PERMISSION_CODES_KEY, context.getHandler()) ??
      Reflect.getMetadata(REQUIRED_PERMISSION_CODES_KEY, context.getClass()) ??
      []
    );
  }

  private getRequiredPermissionMatchMode(context: ExecutionContext): RequiredPermissionMatchMode {
    return (
      Reflect.getMetadata(REQUIRED_PERMISSION_MATCH_MODE_KEY, context.getHandler()) ??
      Reflect.getMetadata(REQUIRED_PERMISSION_MATCH_MODE_KEY, context.getClass()) ??
      'all'
    );
  }
}
