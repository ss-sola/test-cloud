import type { Request } from 'express';

export interface SharedAccountSessionPayload {
  accountId: number;
  accountName: string;
  displayName: string;
  avatarUrl?: string;
  statusVersion: number;
  loginAt: string;
  /** 用户拥有的权限码列表，登录时写入，权限变更时自动同步 */
  permissionCodes: string[];
}

export interface SharedAccountSessionState {
  account?: SharedAccountSessionPayload;
  destroy?: (callback: (error?: unknown) => void) => void;
}

export type CurrentAccountRecord = SharedAccountSessionPayload;

export interface SystemRuntimeMenuRoute {
  id: number;
  code: string;
  name: string;
  path: string;
  component?: string | null;
  icon?: string | null;
  meta?: Record<string, unknown> | null;
  isEnabled?: boolean;
  isHidden?: boolean;
  children: SystemRuntimeMenuRoute[];
}

export interface SystemRuntimeAccount {
  id: number;
  accountName: string;
  displayName: string;
  avatarUrl?: string;
}

export interface SystemRuntimePermissionCurrentResult {
  account: SystemRuntimeAccount;
  roleCodes: string[];
  menuTree: SystemRuntimeMenuRoute[];
}

export interface SystemPermissionCheckResult {
  allowed: boolean;
  missingPermissionCodes: string[];
}

export type AccountSessionRequest = Request & {
  session?: SharedAccountSessionState;
  sessionID?: string;
};
