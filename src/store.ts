import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  AttemptRecord,
  ExecutionRecord,
  TaskExecutionRecord,
  TaskStatus,
  FailureInjection,
  FailureInjectionMode,
  WorkflowDefinition,
  WorkflowStatus,
} from "./types.js";
import type { CircuitSnapshot } from "./circuit-breaker.js";

type TaskRow = {
  task_id: string;
  status: TaskStatus;
  attempts: number;
  output_json: string | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
};

export interface StoredWorkflow {
  workflow: WorkflowDefinition;
  updatedAt: string;
}

const now = (): string => new Date().toISOString();
const encode = (value: unknown): string => JSON.stringify(value);
const decode = (value: string | null): unknown => value === null ? undefined : JSON.parse(value);

export class ExecutionStore {
  private readonly db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    if (path !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_tasks (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        PRIMARY KEY (workflow_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_dependencies (
        workflow_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        PRIMARY KEY (workflow_id, task_id, depends_on),
        FOREIGN KEY (workflow_id, task_id)
          REFERENCES workflow_tasks(workflow_id, task_id) ON DELETE CASCADE,
        FOREIGN KEY (workflow_id, depends_on)
          REFERENCES workflow_tasks(workflow_id, task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS workflow_dependencies_parent_idx
        ON workflow_dependencies(workflow_id, depends_on);
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        workflow_json TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS executions_status_idx ON executions(status);
      CREATE TABLE IF NOT EXISTS task_executions (
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        output_json TEXT,
        error TEXT,
        started_at TEXT,
        ended_at TEXT,
        duration_ms INTEGER,
        PRIMARY KEY (execution_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS task_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        output_json TEXT,
        UNIQUE (execution_id, task_id, attempt),
        FOREIGN KEY (execution_id, task_id)
          REFERENCES task_executions(execution_id, task_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS execution_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        task_id TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS execution_logs_idx ON execution_logs(execution_id, id);
      CREATE TABLE IF NOT EXISTS circuit_breakers (
        name TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failure_injections (
        workflow_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        delay_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, task_id),
        FOREIGN KEY (workflow_id, task_id)
          REFERENCES workflow_tasks(workflow_id, task_id) ON DELETE CASCADE
      );
    `);
  }

  saveWorkflow(workflow: WorkflowDefinition): void {
    const save = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO workflows(id, name, definition_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name,
          definition_json = excluded.definition_json, updated_at = excluded.updated_at
      `).run(workflow.id, workflow.name, encode(workflow), now());
      this.db.prepare("DELETE FROM workflow_dependencies WHERE workflow_id = ?").run(workflow.id);
      const existingTasks = this.db.prepare(`
        SELECT task_id FROM workflow_tasks WHERE workflow_id = ?
      `).all(workflow.id) as Array<{ task_id: string }>;
      const currentTaskIds = new Set(workflow.tasks.map((task) => task.id));
      const deleteTask = this.db.prepare(`
        DELETE FROM workflow_tasks WHERE workflow_id = ? AND task_id = ?
      `);
      for (const { task_id: taskId } of existingTasks) {
        if (!currentTaskIds.has(taskId)) deleteTask.run(workflow.id, taskId);
      }
      const insertTask = this.db.prepare(`
        INSERT INTO workflow_tasks(workflow_id, task_id, definition_json) VALUES (?, ?, ?)
        ON CONFLICT(workflow_id, task_id) DO UPDATE SET definition_json = excluded.definition_json
      `);
      const insertDependency = this.db.prepare(`
        INSERT INTO workflow_dependencies(workflow_id, task_id, depends_on) VALUES (?, ?, ?)
      `);
      for (const task of workflow.tasks) {
        insertTask.run(workflow.id, task.id, encode(task));
        for (const dependency of task.dependencies ?? []) {
          insertDependency.run(workflow.id, task.id, dependency);
        }
      }
    });
    save();
  }

  getWorkflow(workflowId: string): StoredWorkflow | undefined {
    const row = this.db.prepare(`
      SELECT definition_json, updated_at FROM workflows WHERE id = ?
    `).get(workflowId) as { definition_json: string; updated_at: string } | undefined;
    return row ? {
      workflow: JSON.parse(row.definition_json) as WorkflowDefinition,
      updatedAt: row.updated_at,
    } : undefined;
  }

  listWorkflows(): StoredWorkflow[] {
    return (this.db.prepare(`
      SELECT definition_json, updated_at FROM workflows ORDER BY updated_at DESC, id
    `).all() as Array<{ definition_json: string; updated_at: string }>).map((row) => ({
      workflow: JSON.parse(row.definition_json) as WorkflowDefinition,
      updatedAt: row.updated_at,
    }));
  }

  deleteWorkflow(workflowId: string): boolean {
    if (this.hasRunningExecution(workflowId)) return false;
    return this.db.prepare("DELETE FROM workflows WHERE id = ?").run(workflowId).changes > 0;
  }

  hasRunningExecution(workflowId: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM executions WHERE workflow_id = ? AND status = 'RUNNING' LIMIT 1
    `).get(workflowId) !== undefined;
  }

  getTaskDefinition(workflowId: string, taskId: string): WorkflowDefinition["tasks"][number] | undefined {
    const workflow = this.getWorkflow(workflowId)?.workflow;
    return workflow?.tasks.find((task) => task.id === taskId);
  }

  setFailureInjection(
    workflowId: string,
    taskId: string,
    mode: FailureInjectionMode,
    delayMs = 0,
  ): FailureInjection {
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO failure_injections(workflow_id, task_id, mode, delay_ms, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id, task_id) DO UPDATE SET
        mode = excluded.mode, delay_ms = excluded.delay_ms, created_at = excluded.created_at
    `).run(workflowId, taskId, mode, delayMs, createdAt);
    return { workflowId, taskId, mode, delayMs, createdAt };
  }

  takeFailureInjection(workflowId: string, taskId: string): FailureInjection | undefined {
    const select = this.db.prepare(`
      SELECT mode, delay_ms, created_at FROM failure_injections
      WHERE workflow_id = ? AND task_id = ?
    `);
    const row = select.get(workflowId, taskId) as {
      mode: FailureInjectionMode; delay_ms: number; created_at: string;
    } | undefined;
    if (!row) return undefined;
    if (row.mode === "FAIL_ONCE") {
      const consume = this.db.transaction(() => {
        const current = select.get(workflowId, taskId) as typeof row | undefined;
        if (current?.mode !== "FAIL_ONCE") return false;
        return this.db.prepare(`
          DELETE FROM failure_injections WHERE workflow_id = ? AND task_id = ? AND mode = 'FAIL_ONCE'
        `).run(workflowId, taskId).changes > 0;
      });
      if (!consume()) return this.takeFailureInjection(workflowId, taskId);
    }
    return {
      workflowId, taskId, mode: row.mode, delayMs: row.delay_ms, createdAt: row.created_at,
    };
  }

  listFailureInjections(): FailureInjection[] {
    return (this.db.prepare(`
      SELECT workflow_id, task_id, mode, delay_ms, created_at
      FROM failure_injections ORDER BY created_at DESC
    `).all() as Array<{
      workflow_id: string; task_id: string; mode: FailureInjectionMode;
      delay_ms: number; created_at: string;
    }>).map((row) => ({
      workflowId: row.workflow_id,
      taskId: row.task_id,
      mode: row.mode,
      delayMs: row.delay_ms,
      createdAt: row.created_at,
    }));
  }

  deleteFailureInjection(workflowId: string, taskId: string): boolean {
    return this.db.prepare(`
      DELETE FROM failure_injections WHERE workflow_id = ? AND task_id = ?
    `).run(workflowId, taskId).changes > 0;
  }

  listExecutions(options: { limit?: number; offset?: number; status?: WorkflowStatus } = {}): ExecutionRecord[] {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = options.status
      ? this.db.prepare(`
          SELECT id FROM executions WHERE status = ? ORDER BY started_at DESC LIMIT ? OFFSET ?
        `).all(options.status, limit, offset)
      : this.db.prepare(`
          SELECT id FROM executions ORDER BY started_at DESC LIMIT ? OFFSET ?
        `).all(limit, offset);
    return (rows as Array<{ id: string }>).map((row) => this.getExecution(row.id)!)
      .filter((execution): execution is ExecutionRecord => execution !== undefined);
  }

  getMonitoringOverview(): {
    totalWorkflows: number;
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    runningExecutions: number;
    successRate: number;
  } {
    const workflows = this.db.prepare("SELECT COUNT(*) AS count FROM workflows").get() as { count: number };
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN status IN ('FAILED', 'PARTIAL') THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running
      FROM executions
    `).get() as { total: number; successful: number | null; failed: number | null; running: number | null };
    const completed = (row.successful ?? 0) + (row.failed ?? 0);
    return {
      totalWorkflows: workflows.count,
      totalExecutions: row.total,
      successfulExecutions: row.successful ?? 0,
      failedExecutions: row.failed ?? 0,
      runningExecutions: row.running ?? 0,
      successRate: completed === 0 ? 0 : (row.successful ?? 0) / completed,
    };
  }

  getMetrics(): {
    executionsByStatus: Array<{ status: WorkflowStatus; count: number }>;
    tasksByStatus: Array<{ status: TaskStatus; count: number }>;
    averageTaskDurationMs: number;
    taskAttempts: number;
  } {
    const executionsByStatus = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM executions GROUP BY status ORDER BY status
    `).all() as Array<{ status: WorkflowStatus; count: number }>;
    const tasksByStatus = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM task_executions GROUP BY status ORDER BY status
    `).all() as Array<{ status: TaskStatus; count: number }>;
    const taskMetrics = this.db.prepare(`
      SELECT COALESCE(AVG(duration_ms), 0) AS average_duration,
        (SELECT COUNT(*) FROM task_attempts) AS attempts
      FROM task_executions WHERE duration_ms IS NOT NULL
    `).get() as { average_duration: number; attempts: number };
    return {
      executionsByStatus,
      tasksByStatus,
      averageTaskDurationMs: taskMetrics.average_duration,
      taskAttempts: taskMetrics.attempts,
    };
  }

  createExecution(workflow: WorkflowDefinition): string {
    const id = randomUUID();
    const timestamp = now();
    const create = this.db.transaction(() => {
      this.saveWorkflow(workflow);
      this.db.prepare(`
        INSERT INTO executions(id, workflow_id, workflow_name, workflow_json, status, started_at)
        VALUES (?, ?, ?, ?, 'RUNNING', ?)
      `).run(id, workflow.id, workflow.name, encode(workflow), timestamp);
      const insertTask = this.db.prepare(`
        INSERT INTO task_executions(execution_id, task_id, status)
        VALUES (?, ?, 'PENDING')
      `);
      for (const task of workflow.tasks) insertTask.run(id, task.id);
    });
    create();
    return id;
  }

  setTaskStatus(
    executionId: string,
    taskId: string,
    status: TaskStatus,
    details: Partial<Pick<TaskExecutionRecord, "output" | "error" | "startedAt" | "endedAt" | "durationMs">> = {},
  ): void {
    this.db.prepare(`
      UPDATE task_executions SET status = ?,
        output_json = COALESCE(?, output_json),
        error = ?,
        started_at = COALESCE(?, started_at),
        ended_at = ?,
        duration_ms = COALESCE(?, duration_ms)
      WHERE execution_id = ? AND task_id = ?
    `).run(
      status,
      details.output === undefined ? null : encode(details.output),
      details.error ?? null,
      details.startedAt ?? null,
      details.endedAt ?? null,
      details.durationMs ?? null,
      executionId,
      taskId,
    );
  }

  startAttempt(executionId: string, taskId: string, attempt: number, startedAt: string): void {
    const start = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO task_attempts(execution_id, task_id, attempt, status, started_at)
        VALUES (?, ?, ?, 'RUNNING', ?)
      `).run(executionId, taskId, attempt, startedAt);
      this.db.prepare(`
        UPDATE task_executions SET attempts = MAX(attempts, ?), status = 'RUNNING',
          started_at = COALESCE(started_at, ?), ended_at = NULL
        WHERE execution_id = ? AND task_id = ?
      `).run(attempt, startedAt, executionId, taskId);
    });
    start();
  }

  finishAttempt(record: AttemptRecord): void {
    this.db.prepare(`
      UPDATE task_attempts SET status = ?, ended_at = ?, duration_ms = ?, error = ?, output_json = ?
      WHERE execution_id = ? AND task_id = ? AND attempt = ?
    `).run(
      record.status,
      record.endedAt ?? null,
      record.durationMs ?? null,
      record.error ?? null,
      record.output === undefined ? null : encode(record.output),
      record.executionId,
      record.taskId,
      record.attempt,
    );
  }

  finishExecution(executionId: string, status: WorkflowStatus): void {
    this.db.prepare("UPDATE executions SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, now(), executionId);
  }

  addLog(executionId: string, level: "INFO" | "WARN" | "ERROR", message: string, taskId?: string): void {
    this.db.prepare(`
      INSERT INTO execution_logs(execution_id, task_id, level, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(executionId, taskId ?? null, level, message, now());
  }

  getExecution(executionId: string): ExecutionRecord | undefined {
    const execution = this.db.prepare(`
      SELECT id, workflow_id, workflow_name, status, started_at, ended_at
      FROM executions WHERE id = ?
    `).get(executionId) as {
      id: string; workflow_id: string; workflow_name: string; status: WorkflowStatus;
      started_at: string; ended_at: string | null;
    } | undefined;
    if (!execution) return undefined;
    const taskRows = this.db.prepare(`
      SELECT task_id, status, attempts, output_json, error, started_at, ended_at, duration_ms
      FROM task_executions WHERE execution_id = ? ORDER BY rowid
    `).all(executionId) as TaskRow[];
    return {
      id: execution.id,
      workflowId: execution.workflow_id,
      workflowName: execution.workflow_name,
      status: execution.status,
      startedAt: execution.started_at,
      endedAt: execution.ended_at ?? undefined,
      tasks: taskRows.map((row) => ({
        taskId: row.task_id,
        status: row.status,
        attempts: row.attempts,
        output: decode(row.output_json),
        error: row.error ?? undefined,
        startedAt: row.started_at ?? undefined,
        endedAt: row.ended_at ?? undefined,
        durationMs: row.duration_ms ?? undefined,
      })),
    };
  }

  getWorkflowForExecution(executionId: string): WorkflowDefinition | undefined {
    const row = this.db.prepare("SELECT workflow_json FROM executions WHERE id = ?").get(executionId) as
      { workflow_json: string } | undefined;
    return row ? JSON.parse(row.workflow_json) as WorkflowDefinition : undefined;
  }

  getRecoverableExecutions(): string[] {
    return (this.db.prepare("SELECT id FROM executions WHERE status = 'RUNNING' ORDER BY started_at")
      .all() as Array<{ id: string }>).map((row) => row.id);
  }

  recoverInterruptedTasks(executionId: string): number {
    const recover = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT task_id FROM task_executions
        WHERE execution_id = ? AND status IN ('READY', 'RUNNING', 'RETRYING')
      `).all(executionId) as Array<{ task_id: string }>;
      const markAttempt = this.db.prepare(`
        UPDATE task_attempts SET status = 'INTERRUPTED', ended_at = ?, duration_ms =
          CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER), error = ?
        WHERE execution_id = ? AND task_id = ? AND status = 'RUNNING'
      `);
      const resetTask = this.db.prepare(`
        UPDATE task_executions SET status = 'PENDING', error = NULL, ended_at = NULL, duration_ms = NULL
        WHERE execution_id = ? AND task_id = ?
      `);
      const timestamp = now();
      for (const row of rows) {
        markAttempt.run(
          timestamp, timestamp, "Execution was interrupted; task will be retried.", executionId, row.task_id,
        );
        resetTask.run(executionId, row.task_id);
        this.addLog(executionId, "WARN", "Recovered unfinished task; retrying at least once.", row.task_id);
      }
      return rows.length;
    });
    return recover();
  }

  getAttemptHistory(executionId: string, taskId?: string): AttemptRecord[] {
    const rows = taskId
      ? this.db.prepare(`
          SELECT execution_id, task_id, attempt, status, started_at, ended_at, duration_ms, error, output_json
          FROM task_attempts WHERE execution_id = ? AND task_id = ? ORDER BY attempt
        `).all(executionId, taskId)
      : this.db.prepare(`
          SELECT execution_id, task_id, attempt, status, started_at, ended_at, duration_ms, error, output_json
          FROM task_attempts WHERE execution_id = ? ORDER BY task_id, attempt
        `).all(executionId);
    return (rows as Array<{
      execution_id: string; task_id: string; attempt: number;
      status: AttemptRecord["status"]; started_at: string; ended_at: string | null;
      duration_ms: number | null; error: string | null; output_json: string | null;
    }>).map((row) => ({
      executionId: row.execution_id,
      taskId: row.task_id,
      attempt: row.attempt,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      error: row.error ?? undefined,
      output: decode(row.output_json),
    }));
  }

  getLogs(executionId: string): Array<{ taskId?: string; level: string; message: string; createdAt: string }> {
    return (this.db.prepare(`
      SELECT task_id, level, message, created_at FROM execution_logs
      WHERE execution_id = ? ORDER BY id
    `).all(executionId) as Array<{
      task_id: string | null; level: string; message: string; created_at: string;
    }>).map((row) => ({
      taskId: row.task_id ?? undefined,
      level: row.level,
      message: row.message,
      createdAt: row.created_at,
    }));
  }

  getCircuitSnapshot(name: string): CircuitSnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot_json FROM circuit_breakers WHERE name = ?").get(name) as
      { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as CircuitSnapshot : undefined;
  }

  saveCircuitSnapshot(snapshot: CircuitSnapshot): void {
    this.db.prepare(`
      INSERT INTO circuit_breakers(name, snapshot_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
    `).run(snapshot.name, encode(snapshot), now());
  }

  listCircuitSnapshots(): CircuitSnapshot[] {
    return (this.db.prepare("SELECT snapshot_json FROM circuit_breakers ORDER BY name").all() as
      Array<{ snapshot_json: string }>).map((row) => JSON.parse(row.snapshot_json) as CircuitSnapshot);
  }

  close(): void {
    this.db.close();
  }
}
