import { resolve } from 'node:path';

const MIB = 1024 * 1024;

/** system-service 根目录：src/constants 与 dist/constants 均上溯两层，不依赖 cwd。 */
const SERVICE_ROOT = resolve(__dirname, '../..');

/** 固定的工作流数据目录；对外只暴露其相对展示路径，且不提供可变配置。 */
export const WORKFLOW_DIRECTORY_ROOT = resolve(SERVICE_ROOT, 'public', 'workflow');

/** 接口返回的展示路径。 */
export const WORKFLOW_DIRECTORY_DISPLAY_PATH = 'public/workflow';

/** 校验与规范化所复用的前端脚本目录，依次尝试源码 public 与构建产物 dist/public。 */
export const WORKFLOW_DIRECTORY_SCRIPT_ROOTS = Object.freeze([
  resolve(SERVICE_ROOT, 'public', 'js'),
  resolve(SERVICE_ROOT, 'dist', 'public', 'js'),
]);

export const WORKFLOW_DIRECTORY_API_PATH = '/api/workflow-directory';

export const WORKFLOW_DIRECTORY_ROUTES = Object.freeze({
  list: 'list',
  document: 'document',
});

/** 各路由允许的 HTTP 方法。 */
export const WORKFLOW_DIRECTORY_ROUTE_METHODS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    [WORKFLOW_DIRECTORY_ROUTES.list]: ['GET'],
    [WORKFLOW_DIRECTORY_ROUTES.document]: ['GET', 'POST'],
  });

/** 4 MiB 文档的 JSON 转义最多放大 6 倍（\u00XX），再预留固定字段包装。 */
const MAX_DOCUMENT_BYTES = 4 * MIB;

export const WORKFLOW_DIRECTORY_LIMITS = Object.freeze({
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxFilenameLength: 120,
  /** 常见文件系统的单段文件名字节上限。 */
  maxFilenameBytes: 255,
  /** 目录枚举的条目上限（含非 JSON 条目），超出明确拒绝而不是截断。 */
  maxListEntries: 1000,
  maxBodyBytes: MAX_DOCUMENT_BYTES * 6 + 4096,
});

export const WORKFLOW_DIRECTORY_FILE_EXTENSION = '.json';

/** 保存用的同目录临时文件前缀：隐藏文件（静态托管 dotfiles 拒绝访问），且不以 .json 结尾因此不会被列出。 */
export const WORKFLOW_DIRECTORY_TEMP_PREFIX = '.save.tmp.';

/** 覆盖保存的跨进程写锁文件名；崩溃遗留不自动抢占，需确认进程已停止后人工删除。 */
export const WORKFLOW_DIRECTORY_LOCK_NAME = '.workflow-write.tmp.lock';

/** Windows 上目标文件被占用时提交可能返回的可重试错误码。 */
export const WORKFLOW_DIRECTORY_BUSY_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
]);

export const WORKFLOW_DIRECTORY_REVISION_PATTERN = /^[0-9a-f]{64}$/;

/** 受控异常的状态与固定文案，不包含路径、正文或系统错误细节。 */
export const WORKFLOW_DIRECTORY_ERRORS = Object.freeze({
  invalidRequest: { status: 400, message: '请求参数不合法' },
  invalidFilename: { status: 400, message: '文件名不合法' },
  invalidDocument: { status: 400, message: '工作流文件内容无效' },
  unsafeFile: { status: 400, message: '文件类型或链接不受支持' },
  forbiddenOrigin: { status: 403, message: '请求来源不受信任' },
  notFound: { status: 404, message: '工作流文件不存在' },
  conflict: { status: 409, message: '文件版本已变化，请重新读取后确认' },
  busy: { status: 409, message: '工作流目录正被占用，请稍后重试' },
  tooLarge: { status: 413, message: '工作流文件超过 4 MiB 限制' },
  tooManyEntries: { status: 413, message: '工作流目录条目数超过上限' },
  directoryUnavailable: { status: 500, message: '工作流目录不可用' },
  internal: { status: 500, message: '服务器内部错误' },
});
