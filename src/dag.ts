import { MAX_TASK_RETRIES, MAX_TASK_TIMER_MS, type TaskDefinition, type WorkflowDefinition } from "./types.js";

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export function topologicalSort(workflow: WorkflowDefinition): string[] {
  if (!workflow.id.trim() || !workflow.name.trim()) {
    throw new WorkflowValidationError("Workflow ID and name must not be empty.");
  }
  const tasks = new Map<string, TaskDefinition>();
  for (const task of workflow.tasks) {
    if (!task.id.trim()) throw new WorkflowValidationError("Task IDs must not be empty.");
    if (tasks.has(task.id)) throw new WorkflowValidationError(`Duplicate task ID: ${task.id}`);
    tasks.set(task.id, task);
  }
  if (tasks.size === 0) throw new WorkflowValidationError("A workflow must contain at least one task.");

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks.values()) {
    const dependencies = task.dependencies ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      throw new WorkflowValidationError(`Task "${task.id}" contains duplicate dependencies.`);
    }
    for (const dependency of dependencies) {
      if (!tasks.has(dependency)) {
        throw new WorkflowValidationError(`Task "${task.id}" depends on unknown task "${dependency}".`);
      }
      if (dependency === task.id) {
        throw new WorkflowValidationError(`Task "${task.id}" cannot depend on itself.`);
      }
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.id]);
    }
    indegree.set(task.id, dependencies.length);
    validateTaskOptions(task);
  }

  const ready = workflow.tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const sorted: string[] = [];
  for (let index = 0; index < ready.length; index += 1) {
    const taskId = ready[index];
    sorted.push(taskId);
    for (const dependent of dependents.get(taskId) ?? []) {
      const count = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }

  if (sorted.length !== tasks.size) {
    throw new WorkflowValidationError("Workflow contains a circular dependency.");
  }
  return sorted;
}

function validateTaskOptions(task: TaskDefinition): void {
  if (!task.name.trim()) throw new WorkflowValidationError(`Task "${task.id}" must have a name.`);
  if (!task.type.trim()) throw new WorkflowValidationError(`Task "${task.id}" must have a type.`);
  if (task.retries !== undefined &&
      (!Number.isInteger(task.retries) || task.retries < 0 || task.retries > MAX_TASK_RETRIES)) {
    throw new WorkflowValidationError(
      `Task "${task.id}" retries must be an integer between 0 and ${MAX_TASK_RETRIES}.`,
    );
  }
  for (const [label, value] of [
    ["retryDelayMs", task.retryDelayMs],
    ["maxRetryDelayMs", task.maxRetryDelayMs],
    ["timeoutMs", task.timeoutMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > MAX_TASK_TIMER_MS)) {
      throw new WorkflowValidationError(
        `Task "${task.id}" ${label} must be between 0 and ${MAX_TASK_TIMER_MS} milliseconds.`,
      );
    }
  }
  if (task.circuitBreaker) {
    const { failureThreshold, resetTimeoutMs, halfOpenMaxCalls = 1 } = task.circuitBreaker;
    if (!task.circuitBreaker.name.trim() || !Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new WorkflowValidationError(`Task "${task.id}" has invalid circuit breaker options.`);
    }
    if (!Number.isFinite(resetTimeoutMs) || resetTimeoutMs < 0 ||
        !Number.isInteger(halfOpenMaxCalls) || halfOpenMaxCalls < 1) {
      throw new WorkflowValidationError(`Task "${task.id}" has invalid circuit breaker options.`);
    }
  }
}
