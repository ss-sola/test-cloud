import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  WORKFLOW_EXECUTION_ERRORS,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_EXECUTION_MESSAGES,
} from '../../constants/workflow-execution.constants';
import { WorkflowExecutionEngineService } from './workflow-execution-engine.service';
import { WorkflowExecutionIoService } from './workflow-execution-io.service';
import { WorkflowExecutionException } from './workflow-execution.exception';
import type {
  ExecutionEvent,
  ExecutionSnapshot,
  WorkflowConfirmationInput,
  WorkflowConfirmationRequest,
  WorkflowEngineState,
  WorkflowEngineWorkspace,
  WorkflowExecutionInput,
  WorkflowExecutionQuery,
  WorkflowRunStatus,
  WorkflowWriteConfirmation,
} from './workflow-execution.types';

interface PendingConfirmation {
  view: WorkflowWriteConfirmation;
  signal: AbortSignal;
  abort(): void;
  settle(accepted: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ExecutionRecord {
  runId: string;
  tokenHash: Buffer;
  revision: number;
  running: boolean;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt: number | null;
  expiresAt: number;
  deadline: number;
  states: Map<string, WorkflowEngineState>;
  nodeTypes: Map<string, string>;
  listeners: Set<(event: ExecutionEvent) => void>;
  pending: Map<string, PendingConfirmation>;
  workspace?: WorkflowEngineWorkspace;
  unsubscribe?: () => void;
  launch?: ReturnType<typeof setImmediate>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  submittedWrites: Set<string>;
  secrets: string[];
  reservationBytes: number;
  retainedBytes: number;
  cancelMessage?: string;
}

/** 有 TTL 的单进程执行任务；订阅与任务生命周期分离，不保存业务参数或可恢复状态。 */
@Injectable()
export class WorkflowExecutionService implements OnModuleDestroy {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly residualReservations = new Map<string, number>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private subscribers = 0;
  private closing = false;

  constructor(
    private readonly engine: WorkflowExecutionEngineService,
    private readonly io: WorkflowExecutionIoService,
  ) {
    this.cleanupTimer = setInterval(
      () => this.collectExpired(),
      WORKFLOW_EXECUTION_LIMITS.cleanupIntervalMs,
    );
    this.cleanupTimer.unref();
  }

  /** 完整预检并原子预留任务容量，返回一次性交付的访问令牌后独立执行。 */
  start(input: WorkflowExecutionInput): { runId: string; accessToken: string; expiresAt: number } {
    if (this.closing) throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.unavailable);
    this.collectExpired();
    const pendingRuns = this.io.pendingRuns();
    const active = new Set([
      ...pendingRuns,
      ...[...this.records.values()]
        .filter((record) => record.running)
        .map((record) => record.runId),
    ]);
    if (
      active.size >= WORKFLOW_EXECUTION_LIMITS.maxActiveRuns ||
      this.records.size >= WORKFLOW_EXECUTION_LIMITS.maxRuns
    ) {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.capacity);
    }
    const runId = randomUUID();
    const accessToken = randomBytes(32).toString('base64url');
    let record!: ExecutionRecord;
    const prepared = this.engine.prepare(input, {
      runId,
      assertActive: () => this.assertActive(record),
      confirm: (request) => this.requestConfirmation(record, request),
    });
    const used =
      [...this.records.values()].reduce(
        (total, item) =>
          total +
          (item.running || pendingRuns.has(item.runId)
            ? item.reservationBytes
            : item.retainedBytes),
        0,
      ) + [...this.residualReservations.values()].reduce((total, bytes) => total + bytes, 0);
    if (used + prepared.reservationBytes > WORKFLOW_EXECUTION_LIMITS.maxMemoryBytes) {
      prepared.workspace.services = {};
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.capacity);
    }
    const startedAt = Date.now();
    const deadline = startedAt + WORKFLOW_EXECUTION_LIMITS.activeTtlMs;
    record = {
      runId,
      tokenHash: createHash('sha256').update(accessToken).digest(),
      revision: 0,
      running: true,
      status: 'running',
      startedAt,
      finishedAt: null,
      expiresAt: deadline,
      deadline,
      states: prepared.states,
      nodeTypes: prepared.nodeTypes,
      listeners: new Set(),
      pending: new Map(),
      workspace: prepared.workspace,
      submittedWrites: prepared.submittedWrites,
      secrets: prepared.secrets,
      reservationBytes: prepared.reservationBytes,
      retainedBytes: 0,
    };
    this.records.set(runId, record);
    record.unsubscribe = prepared.workspace.subscribe((_id, event) =>
      this.updateRuntime(record, event.nodeIds),
    );
    record.deadlineTimer = setTimeout(
      () => this.cancel(record, WORKFLOW_EXECUTION_MESSAGES.expired),
      WORKFLOW_EXECUTION_LIMITS.activeTtlMs,
    );
    record.deadlineTimer.unref();
    record.launch = setImmediate(() => {
      record.launch = undefined;
      if (!record.running) return;
      const execution = prepared.start();
      execution.catch(() => {
        if (!record.running) return;
        for (const [nodeId, state] of record.states) {
          if (state.status === 'queued' || state.status === 'running')
            record.states.set(nodeId, {
              status: 'failed',
              message: WORKFLOW_EXECUTION_MESSAGES.failed,
              outputs: null,
            });
        }
        this.finish(record, 'failed');
      });
    });
    return { runId, accessToken, expiresAt: deadline };
  }

  /** 返回当前白名单快照；指定节点时只返回该节点，读取不会延长 TTL。 */
  status(query: WorkflowExecutionQuery, token: string): ExecutionSnapshot {
    const record = this.authorize(query.runId, token);
    if (query.nodeId !== undefined && !record.nodeTypes.has(query.nodeId)) {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.notFound);
    }
    return this.snapshot(record, {
      outputs: true,
      nodeIds: query.nodeId === undefined ? undefined : [query.nodeId],
      confirmations: true,
    });
  }

  /** 显式停止是幂等操作；已提交的外部写入不能保证撤回。 */
  stop(runId: string, token: string): ExecutionSnapshot {
    const record = this.authorize(runId, token);
    this.cancel(record, WORKFLOW_EXECUTION_MESSAGES.stopped);
    return this.snapshot(record, { outputs: true, confirmations: true });
  }

  /** 在任何异步等待前原子消费一次实际写入决定，不接收替换目标或数据。 */
  confirm(input: WorkflowConfirmationInput, token: string): ExecutionSnapshot {
    const record = this.authorize(input.runId, token);
    const pending = record.pending.get(input.confirmationId);
    if (
      !record.running ||
      !pending ||
      pending.view.expiresAt <= Date.now() ||
      pending.signal.aborted
    ) {
      if (pending) this.settleConfirmation(record, input.confirmationId, false);
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.invalidConfirmation);
    }
    this.assertActive(record);
    this.settleConfirmation(record, input.confirmationId, input.accepted === true);
    return this.snapshot(record, { outputs: false, confirmations: true });
  }

  /** 同步注册并发送当前快照，后续只推送增量；单订阅者异常不会污染节点结果。 */
  subscribe(runId: string, token: string, listener: (event: ExecutionEvent) => void): () => void {
    const record = this.authorize(runId, token);
    if (
      record.listeners.size >= WORKFLOW_EXECUTION_LIMITS.maxSubscribersPerRun ||
      this.subscribers >= WORKFLOW_EXECUTION_LIMITS.maxSubscribers
    ) {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.subscribers);
    }
    const subscription = listener.bind(undefined);
    const unsubscribe = () => {
      if (record.listeners.delete(subscription)) this.subscribers -= 1;
    };
    record.listeners.add(subscription);
    this.subscribers += 1;
    try {
      subscription({
        type: 'snapshot',
        data: this.snapshot(record, { outputs: false, confirmations: true }),
      });
    } catch {
      unsubscribe();
    }
    if (!record.running) unsubscribe();
    return unsubscribe;
  }

  /** 正常关闭清理任务与订阅；进程硬退出不提供恢复或撤销保证。 */
  onModuleDestroy(): void {
    this.closing = true;
    clearInterval(this.cleanupTimer);
    for (const record of this.records.values())
      this.cancel(record, WORKFLOW_EXECUTION_MESSAGES.stopped);
    this.records.clear();
    this.residualReservations.clear();
  }

  /** 校验令牌后检查期限；不存在、过期和错误令牌使用相同响应。 */
  private authorize(runId: string, token: string): ExecutionRecord {
    const record = this.records.get(runId);
    const supplied = createHash('sha256')
      .update(typeof token === 'string' ? token : '')
      .digest();
    if (!record || !timingSafeEqual(record.tokenHash, supplied)) {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.notFound);
    }
    this.collectExpired();
    if (!this.records.has(runId))
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.notFound);
    return record;
  }

  /** 副作用和确认前检查绝对截止时间，不依赖清理扫描的执行时机。 */
  private assertActive(record: ExecutionRecord): void {
    if (record.running && record.deadline <= Date.now())
      this.cancel(record, WORKFLOW_EXECUTION_MESSAGES.expired);
    if (!record.running || this.closing)
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.invalidConfirmation);
  }

  /** 从共用核心采纳状态并以通知观察终态，不等待可能仍在结清的执行 Promise。 */
  private updateRuntime(record: ExecutionRecord, nodeIds?: string[]): void {
    if (!record.running || !record.workspace) return;
    const runtime = record.workspace.getRuntime();
    record.states = runtime.states;
    if (runtime.startedAt !== null) record.startedAt = runtime.startedAt;
    if (!runtime.running) {
      this.finish(record, runtime.status);
      return;
    }
    this.emit(record, nodeIds?.length ? 'node-state' : 'snapshot', {
      nodeIds,
      confirmations: !nodeIds?.length,
    });
  }

  /** 挂起单个实际写入，冻结确认内容并在停止、过期或应答时释放 resolver。 */
  private requestConfirmation(
    record: ExecutionRecord,
    request: WorkflowConfirmationRequest,
  ): Promise<boolean> {
    this.assertActive(record);
    request.signal.throwIfAborted();
    if (
      record.nodeTypes.get(request.nodeId) !== 'feishu-write-cells' ||
      record.pending.size >= WORKFLOW_EXECUTION_LIMITS.maxConfirmations
    ) {
      throw new Error(WORKFLOW_EXECUTION_MESSAGES.confirmationCapacity);
    }
    if (
      Buffer.byteLength(JSON.stringify(request.values)) >
      WORKFLOW_EXECUTION_LIMITS.maxConfirmationBytes
    ) {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.tooLarge);
    }
    const confirmationId = randomUUID();
    const expiresAt = Math.min(
      record.deadline,
      Date.now() + WORKFLOW_EXECUTION_LIMITS.confirmationTtlMs,
    );
    const nodeName =
      typeof request.nodeName === 'string' &&
      !record.secrets.some((secret) => request.nodeName!.includes(secret))
        ? request.nodeName
        : '';
    const view: WorkflowWriteConfirmation = {
      confirmationId,
      nodeId: request.nodeId,
      nodeName,
      wikiUrl: request.wikiUrl,
      range: request.range,
      values: request.values,
      expiresAt,
    };
    return new Promise<boolean>((resolve) => {
      const abort = () => this.settleConfirmation(record, confirmationId, false);
      const timer = setTimeout(abort, Math.max(0, expiresAt - Date.now()));
      timer.unref();
      record.pending.set(confirmationId, {
        view,
        signal: request.signal,
        abort,
        settle: resolve,
        timer,
      });
      request.signal.addEventListener('abort', abort, { once: true });
      this.emit(record, 'confirmations', { nodeIds: [], confirmations: true });
    });
  }

  /** 删除确认后才唤醒执行器，重复或迟到的决定无法再次授权写入。 */
  private settleConfirmation(record: ExecutionRecord, id: string, accepted: boolean): void {
    const pending = record.pending.get(id);
    if (!pending) return;
    record.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener('abort', pending.abort);
    if (record.running) this.emit(record, 'confirmations', { nodeIds: [], confirmations: true });
    pending.settle(
      accepted && record.running && !pending.signal.aborted && pending.view.expiresAt > Date.now(),
    );
  }

  /** 停止未启动或已启动的执行，保留可能已发出的写入提示。 */
  private cancel(record: ExecutionRecord, message: string): void {
    if (!record.running) return;
    record.cancelMessage = message;
    if (record.launch) {
      clearImmediate(record.launch);
      record.launch = undefined;
    }
    record.workspace?.stop();
    if (record.running) {
      for (const [id, state] of record.states) {
        if (state.status === 'running' || state.status === 'queued')
          record.states.set(id, { status: 'cancelled', message, outputs: null });
      }
      this.finish(record, 'cancelled');
    }
  }

  /** 一次性提交终态，仅保留安全结果与摘要；底层未结清调用的额度另行保留。 */
  private finish(record: ExecutionRecord, status: WorkflowRunStatus): void {
    if (!record.running) return;
    record.running = false;
    record.status = status;
    record.finishedAt = Date.now();
    record.expiresAt = record.finishedAt + WORKFLOW_EXECUTION_LIMITS.resultTtlMs;
    clearTimeout(record.deadlineTimer);
    record.deadlineTimer = undefined;
    for (const id of record.pending.keys()) this.settleConfirmation(record, id, false);
    for (const [nodeId, state] of record.states) {
      if (state.status === 'cancelled') {
        const message = record.submittedWrites.has(nodeId)
          ? WORKFLOW_EXECUTION_MESSAGES.uncertainWrite
          : (record.cancelMessage ?? state.message);
        record.states.set(nodeId, { ...state, message });
      }
    }
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    if (record.workspace) record.workspace.services = {};
    record.workspace = undefined;
    record.secrets = [];
    record.submittedWrites.clear();
    record.retainedBytes =
      Buffer.byteLength(JSON.stringify([...record.states])) +
      WORKFLOW_EXECUTION_LIMITS.metadataReserveBytes;
    this.emit(record, 'run-finished', { nodeIds: [], confirmations: true });
    this.subscribers -= record.listeners.size;
    record.listeners.clear();
  }

  /** 事件只携带白名单状态，完整输出仅通过受令牌保护的快照查询。 */
  private snapshot(
    record: ExecutionRecord,
    options: { outputs: boolean; nodeIds?: string[]; confirmations?: boolean },
  ): ExecutionSnapshot {
    const ids = options.nodeIds ?? [...record.states.keys()];
    return {
      runId: record.runId,
      revision: record.revision,
      running: record.running,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      expiresAt: record.expiresAt,
      states: ids.flatMap((nodeId) => {
        const state = record.states.get(nodeId);
        return state
          ? [
              {
                nodeId,
                status: state.status,
                message: state.message,
                ...(options.outputs ? { outputs: state.outputs } : {}),
              },
            ]
          : [];
      }),
      ...(options.confirmations
        ? { confirmations: [...record.pending.values()].map((pending) => pending.view) }
        : {}),
    };
  }

  /** 每次变更单调推进版本；慢或异常订阅独立退订，不向核心抛出错误。 */
  private emit(
    record: ExecutionRecord,
    type: ExecutionEvent['type'],
    options: { nodeIds?: string[]; confirmations?: boolean },
  ): void {
    record.revision += 1;
    if (!record.listeners.size) return;
    const event: ExecutionEvent = {
      type,
      data: this.snapshot(record, { ...options, outputs: false }),
    };
    for (const listener of record.listeners) {
      try {
        listener(event);
      } catch {
        if (record.listeners.delete(listener)) this.subscribers -= 1;
      }
    }
  }

  /** 清理固定期限记录，残留调用保留容量账本直至原始 Promise 真正结清。 */
  private collectExpired(): void {
    const now = Date.now();
    const pending = this.io.pendingRuns();
    for (const runId of this.residualReservations.keys()) {
      if (!pending.has(runId)) this.residualReservations.delete(runId);
    }
    for (const record of this.records.values()) {
      if (record.running && record.deadline <= now)
        this.cancel(record, WORKFLOW_EXECUTION_MESSAGES.expired);
      if (!record.running && record.expiresAt <= now) {
        if (pending.has(record.runId))
          this.residualReservations.set(record.runId, record.reservationBytes);
        this.records.delete(record.runId);
      }
    }
  }
}
