export type TaskStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "RETRYING"
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED"
  | "TIMED_OUT"
  | "CANCELLED";

export type WorkflowStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "PARTIAL" | "CANCELLED";

export const MAX_TASK_RETRIES = 20;
export const MAX_TASK_TIMER_MS = 2_147_483_647;

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxCalls?: number;
}

export type FailureInjectionMode =
  | "FAIL_ONCE"
  | "FAIL_ALWAYS"
  | "SLOW"
  | "TIMEOUT"
  | "SERVICE_UNAVAILABLE";

export interface FailureInjection {
  workflowId: string;
  taskId: string;
  mode: FailureInjectionMode;
  delayMs: number;
  createdAt: string;
}

export interface TaskDefinition {
  id: string;
  name: string;
  type: string;
  dependencies?: string[];
  config?: Record<string, unknown>;
  retries?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  timeoutMs?: number;
  circuitBreaker?: CircuitBreakerOptions;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  tasks: TaskDefinition[];
  maxConcurrency?: number;
}

export interface TaskContext {
  task: TaskDefinition;
  inputs: Record<string, unknown>;
  attempt: number;
  signal: AbortSignal;
}

export type TaskHandler = (context: TaskContext) => Promise<unknown> | unknown;

export interface TaskExecutionRecord {
  taskId: string;
  status: TaskStatus;
  attempts: number;
  output?: unknown;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  status: WorkflowStatus;
  startedAt: string;
  endedAt?: string;
  tasks: TaskExecutionRecord[];
}

export interface ExecutionResult extends ExecutionRecord {}

export interface AttemptRecord {
  executionId: string;
  taskId: string;
  attempt: number;
  status: "RUNNING" | "SUCCESS" | "FAILED" | "TIMED_OUT" | "INTERRUPTED" | "CANCELLED";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
  output?: unknown;
}
