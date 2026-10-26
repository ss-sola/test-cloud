import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { isISO8601 } from 'class-validator';
import { ISO_DATE_TIME_PATTERN } from '../../constants/workflow-capability.constants';
import { WORKFLOW_DIRECTORY_SCRIPT_ROOTS } from '../../constants/workflow-directory.constants';
import {
  WORKFLOW_EXECUTION_ERRORS,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_EXECUTION_MESSAGES,
} from '../../constants/workflow-execution.constants';
import { WorkflowExecutionCapabilityService } from './workflow-execution-capability.service';
import { WorkflowExecutionException } from './workflow-execution.exception';
import type {
  PreparedWorkflowExecution,
  WorkflowConfirmationRequest,
  WorkflowEngineDocument,
  WorkflowEngineWorkspace,
  WorkflowExecutionInput,
} from './workflow-execution.types';

interface WorkflowScripts {
  core: {
    parseDocument(raw: string, registry: unknown): WorkflowEngineDocument;
    ExecutionPool: new () => unknown;
    Workspace: new (options: object) => WorkflowEngineWorkspace;
  };
  nodes: { createRegistry(): unknown; createServices(options: object): Record<string, unknown> };
  data: { createDateRange(config: object, now: Date, timeZone: string): unknown };
}

/** 为每次执行创建独立上下文，仅复用注册定义与有界节点池。 */
@Injectable()
export class WorkflowExecutionEngineService {
  private scripts?: WorkflowScripts;
  private registry?: unknown;
  private pool?: unknown;

  constructor(private readonly capabilities: WorkflowExecutionCapabilityService) {}

  /** 在产生任何副作用前校验完整文档、显式上游输出、日期上下文与运行预算。 */
  prepare(
    input: WorkflowExecutionInput,
    lifecycle: {
      runId: string;
      assertActive(): void;
      confirm(request: WorkflowConfirmationRequest): Promise<boolean>;
    },
  ): PreparedWorkflowExecution {
    const limits = WORKFLOW_EXECUTION_LIMITS;
    if (
      typeof input.document !== 'string' ||
      Buffer.byteLength(input.document) > limits.maxDocumentBytes
    ) {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.tooLarge);
    }
    if ((input.fromNodeId !== undefined) !== (input.previousOutputs !== undefined)) {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.invalidRequest);
    }
    const scripts = this.loadScripts();
    let document: WorkflowEngineDocument;
    try {
      document = scripts.core.parseDocument(input.document, this.registry);
    } catch {
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.invalidDocument);
    }
    const runtime = structuredClone(input.runtime);
    const dateContext = input.dateContext ? { ...input.dateContext } : undefined;
    const runtimeSecrets = [runtime.githubToken, runtime.ai?.apiKey, runtime.feishuAppSecret];
    const startSecrets = document.nodes
      .filter((node) => node.type === 'start')
      .flatMap((node) => [
        node.config.githubToken,
        node.config.aiApiKey,
        node.config.feishuAppSecret,
      ])
      .map((value) => (typeof value === 'string' ? value.trim() : value));
    const secrets = [
      ...new Set(
        [...runtimeSecrets, ...startSecrets].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
      ),
    ];
    const submittedWrites = new Set<string>();
    const safeMessage = (error: unknown): string => {
      const message = error instanceof Error ? error.message : '';
      return message && message.length <= 500 && !secrets.some((secret) => message.includes(secret))
        ? message
        : WORKFLOW_EXECUTION_MESSAGES.failed;
    };
    const services = scripts.nodes.createServices({
      readCredentials: () => runtime,
      invoke: (call: Parameters<WorkflowExecutionCapabilityService['invoke']>[0]) =>
        this.capabilities.invoke(call, {
          runId: lifecycle.runId,
          assertActive: lifecycle.assertActive,
          onWrite: (nodeId: string) => submittedWrites.add(nodeId),
        }),
      compare: (value: Parameters<WorkflowExecutionCapabilityService['compare']>[0]) => {
        lifecycle.assertActive();
        return this.capabilities.compare(value);
      },
      confirmWrite: lifecycle.confirm,
    });
    services.dateRange = (config: object) => {
      lifecycle.assertActive();
      if (!dateContext) throw new Error(WORKFLOW_EXECUTION_ERRORS.invalidDateContext.message);
      return scripts.data.createDateRange(config, new Date(dateContext.now), dateContext.timeZone);
    };
    const workspace = new scripts.core.Workspace({
      registry: this.registry,
      document,
      pool: this.pool,
      runId: lifecycle.runId,
      services,
      validateOutputs: (outputs: object) => {
        if (!secrets.length) return;
        const pending: unknown[] = [outputs];
        const visited = new WeakSet<object>();
        while (pending.length) {
          const value = pending.pop();
          if (typeof value === 'string' && secrets.some((secret) => value.includes(secret))) {
            throw new Error('节点输出包含本次执行凭据，已拒绝分发。');
          }
          if (value && typeof value === 'object' && !visited.has(value)) {
            visited.add(value);
            for (const [key, child] of Object.entries(value)) pending.push(key, child);
          }
        }
      },
      sanitizeError: safeMessage,
    });
    try {
      const previous = input.previousOutputs ?? [];
      if (
        previous.length > limits.maxPreviousOutputs ||
        Buffer.byteLength(JSON.stringify(previous)) > limits.maxPreviousBytes
      ) {
        throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.tooLarge);
      }
      if (previous.length) workspace.restoreOutputs(previous);
      const prepared = workspace.prepareRun(input.fromNodeId);
      const provided = new Set(previous.map((item) => item.nodeId));
      if (
        provided.size !== previous.length ||
        provided.size !== prepared.reusedNodeIds.size ||
        [...provided].some((id) => !prepared.reusedNodeIds.has(id))
      ) {
        throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.invalidDocument);
      }
      if (dateContext) {
        if (
          !ISO_DATE_TIME_PATTERN.test(dateContext.now) ||
          !isISO8601(dateContext.now, { strict: true, strictSeparator: true })
        ) {
          throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.invalidDateContext);
        }
        try {
          new Intl.DateTimeFormat('en-GB', { timeZone: dateContext.timeZone }).format(
            new Date(dateContext.now),
          );
        } catch {
          throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.invalidDateContext);
        }
      }
      if (
        !dateContext &&
        document.nodes.some((node) => node.type === 'date-range' && prepared.scope.has(node.id))
      ) {
        throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.invalidDateContext);
      }
      return {
        workspace,
        states: prepared.states,
        nodeTypes: new Map(document.nodes.map((node) => [node.id, node.type])),
        reservationBytes:
          limits.maxResultBytes +
          Buffer.byteLength(input.document) +
          limits.maxConfirmations * limits.maxConfirmationBytes +
          limits.metadataReserveBytes,
        secrets,
        submittedWrites,
        start: () => (input.fromNodeId ? workspace.runFrom(input.fromNodeId) : workspace.run()),
      };
    } catch (error) {
      workspace.services = {};
      if (error instanceof WorkflowExecutionException) throw error;
      throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.invalidDocument);
    }
  }

  /** 从固定源码或构建资源加载同一份核心与节点定义，不执行用户文件中的代码。 */
  private loadScripts(): WorkflowScripts {
    if (this.scripts) return this.scripts;
    const directory = WORKFLOW_DIRECTORY_SCRIPT_ROOTS.find((root) =>
      existsSync(join(root, 'workflow-nodes.js')),
    );
    if (!directory) throw new WorkflowExecutionException(WORKFLOW_EXECUTION_ERRORS.internal);
    const load = createRequire(__filename);
    const core = load(join(directory, 'workflow-core.js')) as WorkflowScripts['core'];
    const nodes = load(join(directory, 'workflow-nodes.js')) as WorkflowScripts['nodes'];
    const data = load(join(directory, 'workflow-data.js')) as WorkflowScripts['data'];
    this.registry = nodes.createRegistry();
    this.pool = new core.ExecutionPool();
    this.scripts = { core, nodes, data };
    return this.scripts;
  }
}
