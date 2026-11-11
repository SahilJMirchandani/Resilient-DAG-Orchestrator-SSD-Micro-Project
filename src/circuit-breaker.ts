export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failures: number;
  openedAt?: number;
  halfOpenCalls: number;
  halfOpenSuccesses: number;
}

interface CircuitPermit {
  probe: boolean;
  generation: number;
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker "${name}" is open.`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private current: CircuitSnapshot;
  private readonly halfOpenMaxCalls: number;
  private generation = 0;

  constructor(
    name: string,
    private readonly failureThreshold: number,
    private readonly resetTimeoutMs: number,
    halfOpenMaxCalls = 1,
    initial?: CircuitSnapshot,
    private readonly onChange?: (snapshot: CircuitSnapshot) => void | Promise<void>,
  ) {
    this.halfOpenMaxCalls = halfOpenMaxCalls;
    this.current = initial ? { ...initial } : {
      name, state: "CLOSED", failures: 0, halfOpenCalls: 0, halfOpenSuccesses: 0,
    };
    if (this.current.state === "HALF_OPEN") {
      this.current.state = "OPEN";
      this.current.halfOpenCalls = 0;
      this.current.halfOpenSuccesses = 0;
    }
    if (this.current.state === "OPEN" && this.current.openedAt === undefined) {
      this.current.openedAt = Date.now();
    }
  }

  get snapshot(): CircuitSnapshot {
    return { ...this.current };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const permit = await this.acquire();
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      await this.failed(permit);
      throw error;
    }
    await this.succeeded(permit);
    return result;
  }

  private async acquire(): Promise<CircuitPermit> {
    let changed = false;
    if (this.current.state === "OPEN") {
      const openedAt = this.current.openedAt ?? Date.now();
      if (Date.now() - openedAt < this.resetTimeoutMs) throw new CircuitOpenError(this.current.name);
      this.current.state = "HALF_OPEN";
      this.current.halfOpenCalls = 0;
      this.current.halfOpenSuccesses = 0;
      this.generation += 1;
      changed = true;
    }
    if (this.current.state === "HALF_OPEN") {
      if (this.current.halfOpenCalls >= this.halfOpenMaxCalls) {
        throw new CircuitOpenError(this.current.name);
      }
      this.current.halfOpenCalls += 1;
      changed = true;
      if (changed) await this.notify();
      return { probe: true, generation: this.generation };
    }
    if (changed) await this.notify();
    return { probe: false, generation: this.generation };
  }

  private async succeeded(permit: CircuitPermit): Promise<void> {
    if (permit.generation !== this.generation) return;
    if (!permit.probe) {
      if (this.current.state !== "CLOSED") return;
      this.current.failures = 0;
      await this.notify();
      return;
    }
    if (this.current.state !== "HALF_OPEN") return;
    this.current.halfOpenSuccesses += 1;
    if (this.current.halfOpenSuccesses >= this.halfOpenMaxCalls) {
      this.current.state = "CLOSED";
      this.current.failures = 0;
      this.current.openedAt = undefined;
      this.current.halfOpenCalls = 0;
      this.current.halfOpenSuccesses = 0;
      this.generation += 1;
    }
    await this.notify();
  }

  private async failed(permit: CircuitPermit): Promise<void> {
    if (permit.generation !== this.generation) return;
    if (permit.probe && this.current.state !== "HALF_OPEN") return;
    if (!permit.probe && this.current.state !== "CLOSED") return;
    this.current.failures += 1;
    if (permit.probe || this.current.failures >= this.failureThreshold) {
      this.current.state = "OPEN";
      this.current.openedAt = Date.now();
      this.current.halfOpenCalls = 0;
      this.current.halfOpenSuccesses = 0;
      this.generation += 1;
    }
    await this.notify();
  }

  private async notify(): Promise<void> {
    await this.onChange?.(this.snapshot);
  }
}
