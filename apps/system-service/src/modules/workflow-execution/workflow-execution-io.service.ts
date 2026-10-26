import { Injectable } from '@nestjs/common';
import {
  WORKFLOW_EXECUTION_ERRORS,
  WORKFLOW_EXECUTION_LIMITS,
} from '../../constants/workflow-execution.constants';
import { WorkflowExecutionException } from './workflow-execution.exception';

interface CallWaiter {
  runId: string;
  signal: AbortSignal;
  start(): void;
  abort(): void;
}

/** 跨任务记账真实调用 Promise；停止等待不等于底层调用已结清。 */
@Injectable()
export class WorkflowExecutionIoService {
  private active = 0;
  private readonly owners = new Map<string, number>();
  private readonly waiters: CallWaiter[] = [];

  /** 有界等待调用名额，直到原始调用 Promise 结清才归还额度。 */
  async run<T>(input: { runId: string; signal: AbortSignal; call: () => Promise<T> }): Promise<T> {
    const { runId, signal, call } = input;
    signal.throwIfAborted();
    if (
      this.active >= WORKFLOW_EXECUTION_LIMITS.maxInFlightCalls &&
      this.waiters.length >= WORKFLOW_EXECUTION_LIMITS.maxQueuedCalls
    ) {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.capacity);
    }
    const release = await new Promise<() => void>((resolve, reject) => {
      const waiter: CallWaiter = {
        runId,
        signal,
        start: () => {
          signal.removeEventListener('abort', waiter.abort);
          this.active += 1;
          this.owners.set(runId, (this.owners.get(runId) ?? 0) + 1);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active -= 1;
            const remaining = (this.owners.get(runId) ?? 1) - 1;
            if (remaining) this.owners.set(runId, remaining);
            else this.owners.delete(runId);
            this.waiters.shift()?.start();
          });
        },
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      if (this.active < WORKFLOW_EXECUTION_LIMITS.maxInFlightCalls) waiter.start();
      else this.waiters.push(waiter);
    });
    try {
      signal.throwIfAborted();
      return await call();
    } finally {
      release();
    }
  }

  /** 查询包含正在结清调用和排队调用的所有者，供任务容量与过期清理记账。 */
  pendingRuns(): ReadonlySet<string> {
    return new Set([...this.owners.keys(), ...this.waiters.map((waiter) => waiter.runId)]);
  }
}
