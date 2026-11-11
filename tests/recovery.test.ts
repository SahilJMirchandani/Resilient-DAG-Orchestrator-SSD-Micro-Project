import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import { ExecutionStore } from "../src/store.js";

const directories: string[] = [];
const stores: ExecutionStore[] = [];

function openStore(path: string): ExecutionStore {
  const store = new ExecutionStore(path);
  stores.push(store);
  return store;
}

function closeStore(store: ExecutionStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite persistence and crash recovery", () => {
  it("preserves successful work and reruns tasks interrupted while RUNNING", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dag-engine-"));
    directories.push(directory);
    const databasePath = join(directory, "engine.sqlite");
    const workflow = {
      id: "recover", name: "recover",
      tasks: [
        { id: "done", name: "done", type: "completed" },
        { id: "interrupted", name: "interrupted", type: "resume", dependencies: ["done"] },
        { id: "after", name: "after", type: "resume", dependencies: ["interrupted"] },
      ],
    };
    const firstStore = openStore(databasePath);
    const executionId = firstStore.createExecution(workflow);
    firstStore.setTaskStatus(executionId, "done", "SUCCESS", { output: "saved", endedAt: new Date().toISOString() });
    firstStore.startAttempt(executionId, "interrupted", 1, new Date().toISOString());
    closeStore(firstStore);

    const recoveredStore = openStore(databasePath);
    const engine = await WorkflowEngine.create({
      store: recoveredStore,
      handlers: {
        completed: () => { throw new Error("Completed task must not be rerun."); },
        resume: ({ task }) => `recovered:${task.id}`,
      },
    });
    const result = recoveredStore.getExecution(executionId)!;
    expect(result.status).toBe("SUCCESS");
    expect(result.tasks.find((task) => task.taskId === "done")?.output).toBe("saved");
    expect(result.tasks.find((task) => task.taskId === "interrupted")?.attempts).toBe(2);
    expect(recoveredStore.getAttemptHistory(executionId, "interrupted").map((attempt) => attempt.status))
      .toEqual(["INTERRUPTED", "SUCCESS"]);
    expect(recoveredStore.getLogs(executionId).some((log) => log.message.includes("Recovered unfinished task")))
      .toBe(true);
    closeStore(recoveredStore);
  });

  it("resumes a task interrupted during retry backoff", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dag-engine-backoff-"));
    directories.push(directory);
    const databasePath = join(directory, "engine.sqlite");
    const store = openStore(databasePath);
    const workflow = {
      id: "backoff", name: "backoff",
      tasks: [{ id: "task", name: "task", type: "work", retries: 2 }],
    };
    const executionId = store.createExecution(workflow);
    store.startAttempt(executionId, "task", 1, new Date().toISOString());
    store.finishAttempt({
      executionId, taskId: "task", attempt: 1, status: "FAILED",
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), error: "temporary",
    });
    store.setTaskStatus(executionId, "task", "RETRYING", { error: "temporary" });
    closeStore(store);

    const recoveredStore = openStore(databasePath);
    await WorkflowEngine.create({ store: recoveredStore, handlers: { work: () => "done" } });
    expect(recoveredStore.getExecution(executionId)?.status).toBe("SUCCESS");
    expect(recoveredStore.getExecution(executionId)?.tasks[0].attempts).toBe(2);
    closeStore(recoveredStore);
  });

  it("does not reset the configured retry budget when recovering backoff", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dag-engine-retry-budget-"));
    directories.push(directory);
    const databasePath = join(directory, "engine.sqlite");
    const store = openStore(databasePath);
    const workflow = {
      id: "retry-budget", name: "retry-budget",
      tasks: [{ id: "task", name: "task", type: "work", retries: 2 }],
    };
    const executionId = store.createExecution(workflow);
    for (const attempt of [1, 2]) {
      const timestamp = new Date().toISOString();
      store.startAttempt(executionId, "task", attempt, timestamp);
      store.finishAttempt({
        executionId, taskId: "task", attempt, status: "FAILED",
        startedAt: timestamp, endedAt: timestamp, error: "temporary",
      });
    }
    store.setTaskStatus(executionId, "task", "RETRYING", { error: "temporary" });
    closeStore(store);

    let calls = 0;
    const recoveredStore = openStore(databasePath);
    const engine = await WorkflowEngine.create({
      store: recoveredStore,
      handlers: { work: () => { calls += 1; throw new Error("still unavailable"); } },
    });
    const result = recoveredStore.getExecution(executionId)!;
    expect(result.tasks[0].status).toBe("FAILED");
    expect(result.tasks[0].attempts).toBe(3);
    expect(calls).toBe(1);
    closeStore(recoveredStore);
  });

  it("restores an open circuit breaker across a backend restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dag-engine-breaker-recovery-"));
    directories.push(directory);
    const databasePath = join(directory, "engine.sqlite");
    const firstStore = openStore(databasePath);
    firstStore.saveCircuitSnapshot({
      name: "external-service",
      state: "OPEN",
      failures: 3,
      openedAt: Date.now(),
      halfOpenCalls: 0,
      halfOpenSuccesses: 0,
    });
    closeStore(firstStore);

    let calls = 0;
    const recoveredStore = openStore(databasePath);
    const engine = await WorkflowEngine.create({
      store: recoveredStore,
      handlers: { external: () => { calls += 1; return "unexpected"; } },
    });
    const result = await engine.execute({
      id: "breaker-recovery", name: "breaker-recovery",
      tasks: [{
        id: "request",
        name: "request",
        type: "external",
        circuitBreaker: { name: "external-service", failureThreshold: 3, resetTimeoutMs: 60_000 },
      }],
    });
    expect(result.tasks[0].status).toBe("FAILED");
    expect(calls).toBe(0);
    expect(engine.getCircuitBreakers().find((breaker) => breaker.name === "external-service")?.state)
      .toBe("OPEN");
    closeStore(recoveredStore);
  });
});
