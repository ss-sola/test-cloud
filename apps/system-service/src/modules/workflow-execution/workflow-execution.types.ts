export type WorkflowOutputs = Record<string, unknown>;
export type WorkflowNodeStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';
export type WorkflowRunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface WorkflowExecutionRuntime {
  githubToken?: string;
  ai?: { baseUrl?: string; apiKey?: string; model?: string; enableThinking?: boolean };
  feishuAppId?: string;
  feishuAppSecret?: string;
}

export interface WorkflowDateContext {
  now: string;
  timeZone: string;
}

export interface WorkflowPreviousOutput {
  nodeId: string;
  outputs: WorkflowOutputs;
}

export interface WorkflowExecutionInput {
  document: string;
  runtime: WorkflowExecutionRuntime;
  dateContext?: WorkflowDateContext;
  fromNodeId?: string;
  previousOutputs?: WorkflowPreviousOutput[];
}

export interface WorkflowExecutionQuery {
  runId: string;
  nodeId?: string;
}

export interface WorkflowConfirmationInput {
  runId: string;
  confirmationId: string;
  accepted: boolean;
}

export interface WorkflowExecutionNodeState {
  nodeId: string;
  status: WorkflowNodeStatus;
  message: string;
  outputs?: WorkflowOutputs | null;
}

export interface WorkflowWriteConfirmation {
  confirmationId: string;
  nodeId: string;
  nodeName: string;
  wikiUrl: string;
  range: string;
  values: (string | number | boolean | null)[][];
  expiresAt: number;
}

export interface WorkflowConfirmationRequest {
  nodeId: string;
  nodeName?: string;
  wikiUrl: string;
  range: string;
  values: WorkflowWriteConfirmation['values'];
  signal: AbortSignal;
}

export interface ExecutionSnapshot {
  runId: string;
  revision: number;
  running: boolean;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt: number | null;
  expiresAt: number;
  states: WorkflowExecutionNodeState[];
  confirmations?: WorkflowWriteConfirmation[];
}

export interface ExecutionEvent {
  type: 'snapshot' | 'node-state' | 'confirmations' | 'run-finished';
  data: ExecutionSnapshot;
}

export interface WorkflowEngineNode {
  id: string;
  type: string;
  version: number;
  name: string;
  config: Record<string, unknown>;
}

export interface WorkflowEngineDocument {
  id: string;
  nodes: WorkflowEngineNode[];
}

export interface WorkflowEngineState {
  status: WorkflowNodeStatus;
  message: string;
  outputs: WorkflowOutputs | null;
}

export interface WorkflowEngineRuntime {
  running: boolean;
  status: WorkflowRunStatus;
  startedAt: number | null;
  finishedAt: number | null;
  states: Map<string, WorkflowEngineState>;
}

export interface WorkflowEngineWorkspace {
  services: Record<string, unknown>;
  getDocument(): WorkflowEngineDocument;
  getRuntime(): WorkflowEngineRuntime;
  prepareRun(nodeId?: string): {
    scope: Set<string>;
    states: Map<string, WorkflowEngineState>;
    reusedNodeIds: Set<string>;
  };
  restoreOutputs(outputs: WorkflowPreviousOutput[]): void;
  subscribe(
    listener: (id: string, event: { kind: string; nodeIds?: string[] }) => void,
  ): () => void;
  run(): Promise<unknown>;
  runFrom(nodeId: string): Promise<unknown>;
  stop(): void;
}

export interface PreparedWorkflowExecution {
  workspace: WorkflowEngineWorkspace;
  states: Map<string, WorkflowEngineState>;
  nodeTypes: Map<string, string>;
  reservationBytes: number;
  secrets: string[];
  start(): Promise<unknown>;
  submittedWrites: Set<string>;
}
