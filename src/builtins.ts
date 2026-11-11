import type { TaskHandler } from "./types.js";

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Task was aborted.");
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export const builtInHandlers: Record<string, TaskHandler> = {
  constant: ({ task }) => task.config?.value,
  merge: ({ inputs }) => inputs,
  sum: ({ inputs, task }) => {
    const configuredValues = task.config?.values;
    const values = configuredValues === undefined ? Object.values(inputs) : configuredValues;
    if (!Array.isArray(values) || !values.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error(`Task "${task.id}" sum expects finite numeric inputs or config.values.`);
    }
    return values.reduce<number>((total, value) => total + value, 0);
  },
  delay: async ({ task, inputs, signal }) => {
    const delayMs = task.config?.delayMs ?? 0;
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(`Task "${task.id}" delayMs must be a non-negative number.`);
    }
    await wait(delayMs, signal);
    return task.config?.value ?? inputs;
  },
};
