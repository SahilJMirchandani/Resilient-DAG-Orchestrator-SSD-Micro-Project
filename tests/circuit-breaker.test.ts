import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../src/circuit-breaker.js";

describe("circuit breaker", () => {
  it("transitions CLOSED -> OPEN -> HALF_OPEN -> CLOSED", async () => {
    const breaker = new CircuitBreaker("service", 2, 0);
    await expect(breaker.execute(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(breaker.snapshot.state).toBe("CLOSED");
    await expect(breaker.execute(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(breaker.snapshot.state).toBe("OPEN");
    await expect(breaker.execute(async () => "recovered")).resolves.toBe("recovered");
    expect(breaker.snapshot.state).toBe("CLOSED");
    expect(breaker.snapshot.failures).toBe(0);
  });

  it("blocks calls while open and reopens when a half-open probe fails", async () => {
    const breaker = new CircuitBreaker("service", 1, 60_000);
    await expect(breaker.execute(async () => { throw new Error("offline"); })).rejects.toThrow();
    await expect(breaker.execute(async () => "unreachable")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(breaker.snapshot.state).toBe("OPEN");
  });

  it("limits concurrent half-open probes even while persisting state", async () => {
    let releasePersistence!: () => void;
    let operationCalls = 0;
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const breaker = new CircuitBreaker(
      "service",
      1,
      0,
      1,
      {
        name: "service",
        state: "OPEN",
        failures: 1,
        openedAt: Date.now() - 10,
        halfOpenCalls: 0,
        halfOpenSuccesses: 0,
      },
      async () => { await persistenceGate; },
    );

    const probe = breaker.execute(async () => {
      operationCalls += 1;
      return "recovered";
    });
    await expect(breaker.execute(async () => "unexpected")).rejects.toBeInstanceOf(CircuitOpenError);
    releasePersistence();
    await expect(probe).resolves.toBe("recovered");
    expect(operationCalls).toBe(1);
    expect(breaker.snapshot.state).toBe("CLOSED");
  });

  it("does not close when a successful half-open probe finishes after another probe fails", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (value: string) => void;
    let notifyStarted!: () => void;
    let started = 0;
    const bothStarted = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const breaker = new CircuitBreaker("service", 1, 0, 2, {
      name: "service",
      state: "OPEN",
      failures: 1,
      openedAt: Date.now() - 10,
      halfOpenCalls: 0,
      halfOpenSuccesses: 0,
    });

    const first = breaker.execute(() => {
      started += 1;
      if (started === 2) notifyStarted();
      return new Promise<string>((_resolve, reject) => { rejectFirst = reject; });
    });
    const second = breaker.execute(() => {
      started += 1;
      if (started === 2) notifyStarted();
      return new Promise<string>((resolve) => { resolveSecond = resolve; });
    });
    await bothStarted;
    rejectFirst(new Error("probe failed"));
    await expect(first).rejects.toThrow("probe failed");
    resolveSecond("late success");
    await expect(second).resolves.toBe("late success");

    expect(breaker.snapshot.state).toBe("OPEN");
  });
});
