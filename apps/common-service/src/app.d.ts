/**
 * 扩展Request.currentAccount类型
 */
declare namespace Express {
  interface Request {
    currentAccount?: unknown;
    pass?: boolean;
  }
}
