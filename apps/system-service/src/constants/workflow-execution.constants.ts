const MIB = 1024 * 1024;

export const WORKFLOW_EXECUTION_API_PATH = '/api/workflow';
export const WORKFLOW_EXECUTION_TOKEN_HEADER = 'x-workflow-token';
export const WORKFLOW_EXECUTION_ROUTES = Object.freeze({
  run: 'run',
  status: 'status',
  events: 'events',
  stop: 'stop',
  confirm: 'confirm',
});
export const WORKFLOW_EXECUTION_ROUTE_METHODS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    run: ['POST'],
    status: ['GET'],
    events: ['GET'],
    stop: ['POST'],
    confirm: ['POST'],
  });

/** 任务与结果只在单进程短时内存中存在，访问与重连不续期。 */
export const WORKFLOW_EXECUTION_LIMITS = Object.freeze({
  maxDocumentBytes: 4 * MIB,
  maxPreviousBytes: 32 * MIB,
  maxPreviousDepth: 160,
  maxPreviousOutputs: 100,
  maxBodyBytes: 64 * MIB,
  controlBodyBytes: 4096,
  maxActiveRuns: 3,
  maxRuns: 20,
  maxMemoryBytes: 128 * MIB,
  maxResultBytes: 32 * MIB,
  maxConfirmations: 3,
  maxConfirmationBytes: 512 * 1024,
  maxInFlightCalls: 9,
  maxQueuedCalls: 27,
  activeTtlMs: 2 * 60 * 60 * 1000,
  resultTtlMs: 15 * 60 * 1000,
  confirmationTtlMs: 10 * 60 * 1000,
  cleanupIntervalMs: 30_000,
  heartbeatMs: 15_000,
  maxSubscribersPerRun: 4,
  maxSubscribers: 12,
  maxEventBytes: 2 * MIB,
  metadataReserveBytes: 256 * 1024,
  idPattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
  runIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  tokenPattern: /^[A-Za-z0-9_-]{43}$/,
});

export const WORKFLOW_EXECUTION_ERRORS = Object.freeze({
  invalidRequest: { status: 400, message: '工作流执行参数不合法' },
  invalidDocument: {
    status: 400,
    message: '工作流定义或执行依赖不合法，请检查开始节点、连线及上游结果',
  },
  invalidDateContext: { status: 400, message: '日期节点需要本次明确的参考时间与有效时区' },
  forbiddenOrigin: { status: 403, message: '请求来源不受信任' },
  notFound: { status: 404, message: '工作流任务不存在或已过期' },
  invalidConfirmation: { status: 409, message: '写入确认已失效或已处理，请重新查询任务状态' },
  tooLarge: { status: 413, message: '工作流执行参数或结果超过大小限制' },
  capacity: { status: 429, message: '工作流任务容量已满，请等待任务完成或过期后重试' },
  subscribers: { status: 429, message: '工作流进度订阅数超过上限' },
  unavailable: { status: 503, message: '工作流执行服务正在关闭' },
  internal: { status: 500, message: '工作流执行服务暂不可用' },
});

export const WORKFLOW_EXECUTION_MESSAGES = Object.freeze({
  failed: '节点执行失败，请检查本次参数或稍后重试。',
  stopped: '运行已停止。',
  expired: '任务已达到最大存活期限，运行已停止。',
  uncertainWrite: '运行已停止，远端可能已经写入，请核实后再决定是否重试。',
  confirmationExpired: '本次写入确认已过期，未发送写入。',
  confirmationCapacity: '待确认写入数量超过上限，未发送写入。',
});
