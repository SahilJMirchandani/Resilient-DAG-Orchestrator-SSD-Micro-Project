import { CircuitBreaker, CircuitOpenError, type CircuitSnapshot } from "./circuit-breaker.js";
import { topologicalSort } from "./dag.js";
import { ExecutionStore } from "./store.js";
import { MAX_TASK_TIMER_MS } from "./types.js";
import type {
  ExecutionResult,
  TaskDefinition,
  TaskExecutionRecord,
  TaskHandler,
  TaskStatus,
  WorkflowDefinition,
  WorkflowStatus,
} from "./types.js";

export class TaskTimeoutError extends Error {
  constructor(taskId: string, timeoutMs: number) {
    super(`Task "${taskId}" exceeded its ${timeoutMs}ms timeout.`);
    this.name = "TaskTimeoutError";
  }
}

export class TaskExecutionError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = "TaskExecutionError";
  }
}

export class ExecutionCancelledError extends Error {
  constructor(executionId: string) {
    super(`Execution "${executionId}" was cancelled.`);
    this.name = "ExecutionCancelledError";
  }
}

export interface WorkflowEngineOptions {
  store?: ExecutionStore;
  handlers?: Record<string, TaskHandler>;
  defaultMaxConcurrency?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface ExecutionControl {
  cancelled: boolean;
  controllers: Set<AbortController>;
  cancellationController: AbortController;
}

const defaultSleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Operation aborted."));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Operation aborted."));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class WorkflowEngine {
  readonly store: ExecutionStore;
  private readonly handlers = new Map<string, TaskHandler>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly activeExecutions = new Map<string, ExecutionControl>();
  private readonly defaultMaxConcurrency: number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: WorkflowEngineOptions = {}) {
    this.store = options.store ?? new ExecutionStore();
    this.defaultMaxConcurrency = options.defaultMaxConcurrency ?? 4;
    this.sleep = options.sleep ?? defaultSleep;
    for (const [type, handler] of Object.entries(options.handlers ?? {})) this.registerHandler(type, handler);
  }

  static async create(options: WorkflowEngineOptions = {}): Promise<WorkflowEngine> {
    const engine = new WorkflowEngine(options);
    await engine.resumeInterrupted();
    return engine;
  }

  registerHandler(type: string, handler: TaskHandler): void {
    if (!type.trim()) throw new Error("Handler type must not be empty.");
    this.handlers.set(type, handler);
  }

  async execute(workflow: WorkflowDefinition): Promise<ExecutionResult> {
    const executionId = this.prepareExecution(workflow);
    return this.runManaged(executionId, workflow);
  }

  startWorkflow(workflow: WorkflowDefinition): string {
    const executionId = this.prepareExecution(workflow);
    void this.runManaged(executionId, workflow).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.store.addLog(executionId, "ERROR", `Workflow engine failed: ${message}`);
      this.store.finishExecution(executionId, "FAILED");
    });
    return executionId;
  }

  async cancelExecution(executionId: string): Promise<boolean> {
    const control = this.activeExecutions.get(executionId);
    const execution = this.store.getExecution(executionId);
    if (!control || !execution || execution.status !== "RUNNING") return false;
    if (control.cancelled) return true;
    control.cancelled = true;
    const reason = new ExecutionCancelledError(executionId);
    control.cancellationController.abort(reason);
    for (const controller of control.controllers) controller.abort(reason);
    this.store.addLog(executionId, "WARN", "Execution cancellation requested.");
    return true;
  }

  private prepareExecution(workflow: WorkflowDefinition): string {
    topologicalSort(workflow);
    this.validateConcurrency(workflow.maxConcurrency);
    const executionId = this.store.createExecution(workflow);
    this.store.addLog(executionId, "INFO", "Workflow execution started.");
    this.activeExecutions.set(executionId, this.createControl());
    return executionId;
  }

  private async runManaged(executionId: string, workflow: WorkflowDefinition): Promise<ExecutionResult> {
    try {
      return await this.run(executionId, workflow);
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  private createControl(): ExecutionControl {
    return { cancelled: false, controllers: new Set(), cancellationController: new AbortController() };
  }

  async resumeInterrupted(): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    for (const executionId of this.store.getRecoverableExecutions()) {
      if (this.activeExecutions.has(executionId)) continue;
      this.activeExecutions.set(executionId, this.createControl());
      try {
        const workflow = this.store.getWorkflowForExecution(executionId);
        if (!workflow) throw new Error(`Execution "${executionId}" has no persisted workflow definition.`);
        topologicalSort(workflow);
        this.validateConcurrency(workflow.maxConcurrency);
        this.store.recoverInterruptedTasks(executionId);
        this.store.addLog(executionId, "INFO", "Resuming persisted workflow execution.");
        results.push(await this.run(executionId, workflow));
      } finally {
        this.activeExecutions.delete(executionId);
      }
    }
    return results;
  }

  getExecution(executionId: string): ExecutionResult | undefined {
    return this.store.getExecution(executionId);
  }

  getCircuitBreakers(): CircuitSnapshot[] {
    return this.store.listCircuitSnapshots();
  }

  private async run(executionId: string, workflow: WorkflowDefinition): Promise<ExecutionResult> {
    const sortedIds = topologicalSort(workflow);
    const taskById = new Map(workflow.tasks.map((task) => [task.id, task]));
    const execution = this.store.getExecution(executionId);
    if (!execution) throw new Error(`Execution "${executionId}" was not found.`);
    const statuses = new Map(execution.tasks.map((task) => [task.taskId, task.status]));
    const outputs = new Map<string, unknown>(
      execution.tasks.filter((task) => task.status === "SUCCESS").map((task) => [task.taskId, task.output]),
    );
    const records = new Map(execution.tasks.map((task) => [task.taskId, task]));
    const active = new Map<string, Promise<void>>();
    const control = this.activeExecutions.get(executionId);
    if (!control) throw new Error(`Execution "${executionId}" has no active execution control.`);
    this.setWorkflowRunning(executionId);

    while (true) {
      let changed = false;
      for (const taskId of sortedIds) {
        if (statuses.get(taskId) !== "PENDING") continue;
        if (control.cancelled) {
          statuses.set(taskId, "CANCELLED");
          this.store.setTaskStatus(executionId, taskId, "CANCELLED", {
            error: "Execution was cancelled before this task started.",
            endedAt: new Date().toISOString(),
          });
          changed = true;
          continue;
        }
        const task = taskById.get(taskId)!;
        const dependencies = task.dependencies ?? [];
        if (dependencies.some((dependency) => isFailure(statuses.get(dependency)))) {
          statuses.set(taskId, "SKIPPED");
          this.store.setTaskStatus(executionId, taskId, "SKIPPED", {
            error: "Skipped because a dependency did not complete successfully.",
            endedAt: new Date().toISOString(),
          });
          this.store.addLog(executionId, "WARN", "Task skipped because a dependency failed.", taskId);
          changed = true;
          continue;
        }
        if (dependencies.every((dependency) => statuses.get(dependency) === "SUCCESS") &&
            active.size < (workflow.maxConcurrency ?? this.defaultMaxConcurrency)) {
          statuses.set(taskId, "READY");
          this.store.setTaskStatus(executionId, taskId, "READY");
          const inputs = Object.fromEntries(dependencies.map((id) => [id, outputs.get(id)]));
          const taskPromise = this.executeTask(executionId, workflow.id, task, inputs, statuses, records)
            .then((result) => {
              statuses.set(taskId, result.status);
              if (result.status === "SUCCESS") outputs.set(taskId, result.output);
            });
          active.set(taskId, taskPromise);
          changed = true;
        }
      }

      if (active.size === 0) {
        const unfinished = sortedIds.filter((taskId) => !isTerminal(statuses.get(taskId)));
        if (unfinished.length === 0) break;
        if (!changed) throw new Error(`Scheduler stalled with unfinished tasks: ${unfinished.join(", ")}`);
        continue;
      }

      if (active.size > 0) {
        await Promise.race(active.values());
        for (const [taskId, promise] of active) {
          if (statuses.get(taskId) !== "READY" && statuses.get(taskId) !== "RUNNING" &&
              statuses.get(taskId) !== "RETRYING") {
            active.delete(taskId);
            void promise;
          }
        }
      }
    }

    const taskStatuses = [...statuses.values()];
    const hasFailure = taskStatuses.some(isFailure);
    const hasSuccess = taskStatuses.some((status) => status === "SUCCESS");
    const workflowStatus: WorkflowStatus = control.cancelled
      ? "CANCELLED"
      : hasFailure ? (hasSuccess ? "PARTIAL" : "FAILED") : "SUCCESS";
    this.store.finishExecution(executionId, workflowStatus);
    this.store.addLog(executionId, workflowStatus === "SUCCESS" ? "INFO" : "WARN",
      `Workflow execution finished with status ${workflowStatus}.`);
    return this.store.getExecution(executionId)!;
  }

  private async executeTask(
    executionId: string,
    workflowId: string,
    task: TaskDefinition,
    inputs: Record<string, unknown>,
    statuses: Map<string, TaskStatus>,
    records: Map<string, TaskExecutionRecord>,
  ): Promise<{ status: TaskStatus; output?: unknown }> {
    const control = this.activeExecutions.get(executionId);
    if (!control) throw new Error(`Execution "${executionId}" has no active execution control.`);
    const handler = this.handlers.get(task.type);
    if (!handler) {
      const error = `No handler registered for task type "${task.type}".`;
      this.store.setTaskStatus(executionId, task.id, "FAILED", { error, endedAt: new Date().toISOString() });
      this.store.addLog(executionId, "ERROR", error, task.id);
      return { status: "FAILED" };
    }

    const retryCount = task.retries ?? 0;
    const completedAttempts = records.get(task.id)?.attempts ?? 0;
    const firstAttempt = completedAttempts + 1;
    const attemptsRemaining = Math.max(1, retryCount + 1 - completedAttempts);
    const taskStartedAt = new Date().toISOString();
    let lastError: unknown;
    let terminalStatus: TaskStatus = "FAILED";

    for (let runAttempt = 0; runAttempt < attemptsRemaining; runAttempt += 1) {
      const attempt = firstAttempt + runAttempt;
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      const controller = new AbortController();
      control.controllers.add(controller);
      this.store.setTaskStatus(executionId, task.id, "RUNNING", { startedAt: taskStartedAt, error: undefined });
      this.store.startAttempt(executionId, task.id, attempt, startedAt);
      statuses.set(task.id, "RUNNING");
      this.store.addLog(executionId, "INFO", `Task attempt ${attempt} started.`, task.id);

      try {
        const operation = async () => {
          const injection = this.store.takeFailureInjection(workflowId, task.id);
          if (injection?.mode === "FAIL_ONCE" || injection?.mode === "FAIL_ALWAYS" ||
              injection?.mode === "SERVICE_UNAVAILABLE") {
            throw new TaskExecutionError(
              injection.mode === "SERVICE_UNAVAILABLE"
                ? `Injected external service unavailable for task "${task.id}".`
                : `Injected ${injection.mode.toLowerCase()} failure for task "${task.id}".`,
            );
          }
          if ((injection?.mode === "SLOW" || injection?.mode === "TIMEOUT") && injection.delayMs > 0) {
            await this.sleep(injection.delayMs, controller.signal);
          }
          return handler({ task, inputs, attempt, signal: controller.signal });
        };
        const output = task.circuitBreaker
          ? await this.getBreaker(task.circuitBreaker, executionId, task.id)
            .execute(() => this.withTimeout(task, operation, controller))
          : await this.withTimeout(task, operation, controller);
        const endedAt = new Date().toISOString();
        const durationMs = Date.now() - startedMs;
        const totalDurationMs = Date.now() - Date.parse(taskStartedAt);
        this.store.finishAttempt({
          executionId, taskId: task.id, attempt, status: "SUCCESS", startedAt, endedAt, durationMs, output,
        });
        this.store.setTaskStatus(executionId, task.id, "SUCCESS", {
          output, endedAt, durationMs: totalDurationMs,
        });
        this.store.addLog(executionId, "INFO", `Task attempt ${attempt} succeeded.`, task.id);
        return { status: "SUCCESS", output };
      } catch (error) {
        const endedAt = new Date().toISOString();
        const durationMs = Date.now() - startedMs;
        const timedOut = error instanceof TaskTimeoutError;
        const cancelled = control.cancelled;
        const errorMessage = error instanceof Error ? error.message : String(error);
        terminalStatus = cancelled ? "CANCELLED" : timedOut ? "TIMED_OUT" : "FAILED";
        lastError = error;
        this.store.finishAttempt({
          executionId, taskId: task.id, attempt,
          status: cancelled ? "CANCELLED" : timedOut ? "TIMED_OUT" : "FAILED",
          startedAt, endedAt, durationMs, error: errorMessage,
        });
        const canRetry = !cancelled && runAttempt < attemptsRemaining - 1 &&
          !(error instanceof TaskExecutionError && !error.retryable) &&
          !(error instanceof CircuitOpenError);
        if (canRetry) {
          const delay = Math.min(
            (task.retryDelayMs ?? 0) * (2 ** (attempt - 1)),
            task.maxRetryDelayMs ?? MAX_TASK_TIMER_MS,
          );
          this.store.setTaskStatus(executionId, task.id, "RETRYING", { error: errorMessage });
          statuses.set(task.id, "RETRYING");
          this.store.addLog(executionId, "WARN",
            `Attempt ${attempt} failed; retrying after ${delay}ms: ${errorMessage}`, task.id);
          if (delay > 0) {
            try {
              await this.sleep(delay, control.cancellationController.signal);
            } catch (sleepError) {
              if (!control.cancelled) throw sleepError;
              this.store.setTaskStatus(executionId, task.id, "CANCELLED", {
                error: new ExecutionCancelledError(executionId).message,
                endedAt: new Date().toISOString(),
                durationMs: Date.now() - Date.parse(taskStartedAt),
              });
              return { status: "CANCELLED" };
            }
          }
        } else {
          this.store.setTaskStatus(executionId, task.id, terminalStatus, {
            error: errorMessage, endedAt, durationMs: Date.now() - Date.parse(taskStartedAt),
          });
          this.store.addLog(executionId, "ERROR", `Task failed: ${errorMessage}`, task.id);
          return { status: terminalStatus };
        }
      } finally {
        control.controllers.delete(controller);
      }
    }

    const error = lastError instanceof Error ? lastError.message : String(lastError);
    this.store.setTaskStatus(executionId, task.id, terminalStatus, {
      error, endedAt: new Date().toISOString(),
    });
    return { status: terminalStatus };
  }

  private async withTimeout<T>(
    task: TaskDefinition,
    operation: () => Promise<T>,
    controller: AbortController,
  ): Promise<T> {
    if (task.timeoutMs === undefined || task.timeoutMs === 0) return operation();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new TaskTimeoutError(task.id, task.timeoutMs!);
        controller.abort(error);
        reject(error);
      }, task.timeoutMs);
    });
    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private getBreaker(
    options: NonNullable<TaskDefinition["circuitBreaker"]>,
    executionId: string,
    taskId: string,
  ): CircuitBreaker {
    const existing = this.breakers.get(options.name);
    if (existing) return existing;
    const initial = this.store.getCircuitSnapshot(options.name);
    let previousState = initial?.state ?? "CLOSED";
    const breaker = new CircuitBreaker(
      options.name,
      options.failureThreshold,
      options.resetTimeoutMs,
      options.halfOpenMaxCalls ?? 1,
      initial,
      (snapshot) => {
        this.store.saveCircuitSnapshot(snapshot);
        if (snapshot.state !== previousState) {
          this.store.addLog(executionId, "WARN",
            `Circuit breaker "${snapshot.name}" transitioned ${previousState} -> ${snapshot.state}.`, taskId);
          previousState = snapshot.state;
        }
      },
    );
    this.breakers.set(options.name, breaker);
    return breaker;
  }

  private setWorkflowRunning(executionId: string): void {
    // The execution row is created in RUNNING state and remains so during recovery.
    this.store.addLog(executionId, "INFO", "Scheduler is evaluating task dependencies.");
  }

  private validateConcurrency(value: number | undefined): void {
    const maxConcurrency = value ?? this.defaultMaxConcurrency;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("Maximum concurrency must be a positive integer.");
    }
  }
}

function isFailure(status: TaskStatus | undefined): boolean {
  return status === "FAILED" || status === "TIMED_OUT" || status === "SKIPPED" || status === "CANCELLED";
}

function isTerminal(status: TaskStatus | undefined): boolean {
  return status === "SUCCESS" || isFailure(status);
}
