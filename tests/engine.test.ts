import { afterEach, describe, expect, it } from "vitest";
import { WorkflowEngine, TaskTimeoutError } from "../src/engine.js";
import { builtInHandlers } from "../src/builtins.js";
import { ExecutionStore } from "../src/store.js";
import type { WorkflowDefinition } from "../src/types.js";

const stores: ExecutionStore[] = [];
const makeEngine = (options: ConstructorParameters<typeof WorkflowEngine>[0] = {}) => {
  const store = options?.store ?? new ExecutionStore();
  stores.push(store);
  return new WorkflowEngine({ ...options, store });
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("workflow execution", () => {
  it("runs the registered safe built-in handlers on actual task inputs", async () => {
    const engine = makeEngine({ handlers: builtInHandlers });
    const result = await engine.execute({
      id: "builtins", name: "builtins",
      tasks: [
        { id: "left", name: "Left", type: "constant", config: { value: 4 } },
        { id: "right", name: "Right", type: "constant", config: { value: 6 } },
        { id: "sum", name: "Sum", type: "sum", dependencies: ["left", "right"] },
      ],
    });
    expect(result.status).toBe("SUCCESS");
    expect(result.tasks.find((task) => task.taskId === "sum")?.output).toBe(10);
  });

  it("treats a zero timeout as disabled", async () => {
    const engine = makeEngine({ handlers: builtInHandlers });
    const result = await engine.execute({
      id: "no-timeout", name: "no-timeout",
      tasks: [{
        id: "delay", name: "Delay", type: "delay", timeoutMs: 0,
        config: { delayMs: 10, value: "completed" },
      }],
    });

    expect(result.status).toBe("SUCCESS");
    expect(result.tasks[0].output).toBe("completed");
  });

  it("executes dependencies in order, passes outputs, and runs independent tasks concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const handler = async ({ task }: { task: { id: string } }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return task.id;
    };
    const engine = makeEngine({
      handlers: {
        work: handler,
        combine: ({ inputs }) => Object.values(inputs).join("+"),
      },
    });
    const workflow: WorkflowDefinition = {
      id: "parallel", name: "parallel", maxConcurrency: 2,
      tasks: [
        { id: "root-a", name: "Root A", type: "work" },
        { id: "root-b", name: "Root B", type: "work" },
        { id: "join", name: "Join", type: "combine", dependencies: ["root-a", "root-b"] },
      ],
    };

    const result = await engine.execute(workflow);
    expect(result.status).toBe("SUCCESS");
    expect(maxActive).toBe(2);
    expect(result.tasks.find((task) => task.taskId === "join")?.output).toBe("root-a+root-b");
  });

  it("enforces the configured concurrency ceiling", async () => {
    let active = 0;
    let maxActive = 0;
    const engine = makeEngine({
      handlers: {
        work: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 8));
          active -= 1;
        },
      },
    });
    const result = await engine.execute({
      id: "limit", name: "limit", maxConcurrency: 2,
      tasks: ["a", "b", "c", "d"].map((id) => ({ id, name: id, type: "work" })),
    });
    expect(result.status).toBe("SUCCESS");
    expect(maxActive).toBe(2);
  });

  it("retries failures with capped exponential backoff and records each attempt", async () => {
    let calls = 0;
    const delays: number[] = [];
    const engine = makeEngine({
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      handlers: {
        unstable: () => {
          calls += 1;
          if (calls < 3) throw new Error("temporary");
          return { ok: true };
        },
      },
    });
    const result = await engine.execute({
      id: "retry", name: "retry",
      tasks: [{
        id: "task", name: "task", type: "unstable",
        retries: 3, retryDelayMs: 5, maxRetryDelayMs: 8,
      }],
    });
    expect(result.tasks[0].status).toBe("SUCCESS");
    expect(result.tasks[0].attempts).toBe(3);
    expect(delays).toEqual([5, 8]);
    expect(engine.store.getAttemptHistory(result.id, "task").map((attempt) => attempt.status))
      .toEqual(["FAILED", "FAILED", "SUCCESS"]);
  });

  it("integrates circuit breakers with task execution and persists their state", async () => {
    let calls = 0;
    const engine = makeEngine({
      handlers: {
        external: () => {
          calls += 1;
          throw new Error("service unavailable");
        },
      },
    });
    const workflow = {
      id: "breaker", name: "breaker",
      tasks: [{
        id: "request", name: "request", type: "external", retries: 2,
        circuitBreaker: { name: "test-service", failureThreshold: 1, resetTimeoutMs: 60_000 },
      }],
    };

    const result = await engine.execute(workflow);
    expect(result.tasks[0].status).toBe("FAILED");
    expect(calls).toBe(1);
    expect(engine.getCircuitBreakers()[0].state).toBe("OPEN");
  });

  it("counts timeouts as circuit-breaker failures", async () => {
    let calls = 0;
    const engine = makeEngine({
      handlers: {
        external: ({ signal }) => {
          calls += 1;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    });
    const result = await engine.execute({
      id: "timeout-breaker", name: "timeout-breaker",
      tasks: [{
        id: "request", name: "request", type: "external", timeoutMs: 5,
        circuitBreaker: { name: "timeout-service", failureThreshold: 1, resetTimeoutMs: 60_000 },
      }],
    });

    expect(result.tasks[0].status).toBe("TIMED_OUT");
    expect(calls).toBe(1);
    expect(engine.getCircuitBreakers().find((breaker) => breaker.name === "timeout-service")?.state)
      .toBe("OPEN");
  });

  it("times out tasks, skips dependents, and allows independent branches to finish", async () => {
    const engine = makeEngine({
      handlers: {
        slow: ({ signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        value: () => 42,
      },
    });
    const result = await engine.execute({
      id: "isolation", name: "isolation", maxConcurrency: 2,
      tasks: [
        { id: "slow", name: "slow", type: "slow", timeoutMs: 5 },
        { id: "downstream", name: "downstream", type: "value", dependencies: ["slow"] },
        { id: "independent", name: "independent", type: "value" },
      ],
    });
    expect(result.status).toBe("PARTIAL");
    expect(result.tasks.find((task) => task.taskId === "slow")?.status).toBe("TIMED_OUT");
    expect(result.tasks.find((task) => task.taskId === "downstream")?.status).toBe("SKIPPED");
    expect(result.tasks.find((task) => task.taskId === "independent")?.output).toBe(42);
    expect(engine.store.getAttemptHistory(result.id, "slow")[0].error)
      .toContain(new TaskTimeoutError("slow", 5).message);
  });
});
