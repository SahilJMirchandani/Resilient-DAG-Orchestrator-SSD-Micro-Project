import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskExecutionError } from "./engine.js";
import { parseCsv, stringifyCsv } from "./csv.js";
import type { TaskHandler, WorkflowDefinition } from "./types.js";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SAMPLE_CSV_PATH = resolve(projectDirectory, "data", "sample.csv");
export const CSV_EXPORT_DIRECTORY = resolve(projectDirectory, "data", "exports");

export const TEMPLATE_IDS = ["csv-processing", "resilience-recovery", "text-analysis"] as const;
export type TemplateId = typeof TEMPLATE_IDS[number];
export const MAX_CSV_UPLOAD_BYTES = 512 * 1024;
export const MAX_TEXT_INPUT_LENGTH = 100_000;

const TEXT_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "by", "for", "from",
  "had", "has", "have", "in", "into", "is", "it", "its", "may", "of", "on",
  "or", "same", "such", "that", "the", "their", "this", "to", "was", "were",
  "what", "when", "which", "with",
]);

function splitSentences(text: string): string[] {
  return text.match(/[^.!?]+(?:[.!?]+|$)/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function normalizeKeyword(word: string): string {
  const lowerCaseWord = word.toLocaleLowerCase();
  return lowerCaseWord.endsWith("s") && !lowerCaseWord.endsWith("ss") && lowerCaseWord.length > 4
    ? lowerCaseWord.slice(0, -1)
    : lowerCaseWord;
}

export interface TemplateInput {
  csvContent?: string;
  text?: string;
}

export type FailureScenario =
  | "none"
  | "temporary_failure"
  | "permanent_failure"
  | "slow_task"
  | "independent_branch_failure";

export interface ResilienceOptions {
  scenario: FailureScenario;
  failureProbability: number;
  maxAttempts: number;
  taskTimeoutMs: number;
  artificialDelayMs: number;
}

export const DEFAULT_RESILIENCE_OPTIONS: ResilienceOptions = {
  scenario: "none",
  failureProbability: 0,
  maxAttempts: 3,
  taskTimeoutMs: 1000,
  artificialDelayMs: 0,
};

const templates = [
  {
    id: "csv-processing" as const,
    name: "CSV Data Processing Pipeline",
    description: "Upload a CSV or use the included sample to validate, clean, analyze, and export data.",
    nodes: [
      { id: "csv-input", name: "CSV Input", dependencies: [] },
      { id: "data-validation", name: "Data Validation", dependencies: ["csv-input"] },
      { id: "data-cleaning", name: "Data Cleaning", dependencies: ["data-validation"] },
      { id: "data-analysis", name: "Data Analysis", dependencies: ["data-cleaning"] },
      { id: "csv-export", name: "CSV Export", dependencies: ["data-analysis"] },
    ],
  },
  {
    id: "resilience-recovery" as const,
    name: "Resilience and Failure Recovery Pipeline",
    description: "Exercise retries, timeouts, failure isolation, and a service circuit breaker.",
    nodes: [
      { id: "start", name: "Start", dependencies: [] },
      { id: "data-fetch", name: "Data Fetch", dependencies: ["start"] },
      { id: "data-validation", name: "Data Validation", dependencies: ["data-fetch"] },
      { id: "data-processing", name: "Data Processing", dependencies: ["data-validation"] },
      { id: "report-generation", name: "Report Generation", dependencies: ["data-processing"] },
      { id: "health-check", name: "Health Check", dependencies: ["start"] },
    ],
  },
  {
    id: "text-analysis" as const,
    name: "Text Analysis Pipeline",
    description: "Validate user-provided text, calculate useful statistics, and generate a report.",
    nodes: [
      { id: "text-input", name: "Text Input", dependencies: [] },
      { id: "text-validation", name: "Text Validation", dependencies: ["text-input"] },
      { id: "text-analysis", name: "Text Analysis", dependencies: ["text-validation"] },
      { id: "text-report", name: "Report Generation", dependencies: ["text-analysis"] },
    ],
  },
];

export function listTemplates() {
  return templates;
}

export function getTemplate(templateId: string) {
  return templates.find((template) => template.id === templateId);
}

function task(
  id: string,
  name: string,
  type: string,
  dependencies: string[],
  config: Record<string, unknown> = {},
  options: { retries?: number; timeoutMs?: number; retryDelayMs?: number; maxRetryDelayMs?: number; circuitBreaker?: WorkflowDefinition["tasks"][number]["circuitBreaker"] } = {},
): WorkflowDefinition["tasks"][number] {
  return { id, name, type, dependencies, config, ...options };
}

export function createTemplateWorkflow(
  templateId: TemplateId,
  executionKey = randomUUID(),
  options: Partial<ResilienceOptions> = {},
  input: TemplateInput = {},
): WorkflowDefinition {
  const id = `${templateId}:${executionKey}`;
  if (templateId === "csv-processing") {
    return {
      id,
      name: "CSV Data Processing Pipeline",
      maxConcurrency: 2,
      tasks: [
        task("csv-input", "CSV Input", "csv-input", [], {
          filePath: SAMPLE_CSV_PATH,
          ...(input.csvContent === undefined ? {} : { csvContent: input.csvContent }),
        }),
        task("data-validation", "Data Validation", "csv-validate", ["csv-input"]),
        task("data-cleaning", "Data Cleaning", "csv-clean", ["data-validation"]),
        task("data-analysis", "Data Analysis", "csv-analyze", ["data-cleaning"]),
        task("csv-export", "CSV Export", "csv-export", ["data-analysis"], { executionKey }),
      ],
    };
  }
  if (templateId === "text-analysis") {
    return {
      id,
      name: "Text Analysis Pipeline",
      maxConcurrency: 2,
      tasks: [
        task("text-input", "Text Input", "text-input", [], { text: input.text }),
        task("text-validation", "Text Validation", "text-validate", ["text-input"]),
        task("text-analysis", "Text Analysis", "text-analyze", ["text-validation"]),
        task("text-report", "Report Generation", "text-report", ["text-analysis"]),
      ],
    };
  }

  const config = { ...DEFAULT_RESILIENCE_OPTIONS, ...options };
  const common = { ...config };
  const retries = config.maxAttempts - 1;
  const timeoutMs = config.taskTimeoutMs;
  const retryDelayMs = 25;
  const maxRetryDelayMs = 500;
  const demonstratesBreakerRecovery = config.scenario === "temporary_failure";
  const circuitBreaker = {
    name: `${id}:external-service`,
    failureThreshold: demonstratesBreakerRecovery ? 1 : Math.max(1, config.maxAttempts),
    resetTimeoutMs: demonstratesBreakerRecovery ? 10 : 10_000,
    halfOpenMaxCalls: 1,
  };
  const taskConfig = (taskId: string) => ({
    ...common,
    taskId,
    artificialDelayMs: config.scenario === "slow_task" && taskId === "data-fetch"
      ? Math.max(config.artificialDelayMs, config.taskTimeoutMs + 25)
      : config.artificialDelayMs,
  });
  return {
    id,
    name: "Resilience and Failure Recovery Pipeline",
    maxConcurrency: 3,
    tasks: [
      task("start", "Start", "resilience-start", [], taskConfig("start")),
      task("data-fetch", "Data Fetch", "resilience-fetch", ["start"], taskConfig("data-fetch"), {
        retries, timeoutMs, retryDelayMs, maxRetryDelayMs, circuitBreaker,
      }),
      task("data-validation", "Data Validation", "resilience-validate", ["data-fetch"], taskConfig("data-validation"), {
        retries, timeoutMs, retryDelayMs, maxRetryDelayMs,
      }),
      task("data-processing", "Data Processing", "resilience-process", ["data-validation"], taskConfig("data-processing"), {
        retries, timeoutMs, retryDelayMs, maxRetryDelayMs,
      }),
      task("report-generation", "Report Generation", "resilience-report", ["data-processing"], taskConfig("report-generation"), {
        retries, timeoutMs, retryDelayMs, maxRetryDelayMs,
      }),
      task("health-check", "Health Check", "resilience-health", ["start"], taskConfig("health-check"), {
        retries, timeoutMs, retryDelayMs, maxRetryDelayMs,
      }),
    ],
  };
}

function asRows(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) throw new TaskExecutionError("CSV task input is missing rows.", false);
  return value as Array<Record<string, string>>;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateRows(rows: Array<Record<string, string>>) {
  const required = ["customer_id", "name", "email", "amount", "region"];
  const errors: string[] = [];
  const headers = Object.keys(rows[0] ?? {});
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new TaskExecutionError(`CSV is missing required columns: ${missing.join(", ")}.`, false);
  }
  let validRecords = 0;
  rows.forEach((row, index) => {
    const rowErrors: string[] = [];
    if (!row.customer_id.trim()) rowErrors.push("customer_id is missing");
    if (!row.name.trim()) rowErrors.push("name is missing");
    if (!isValidEmail(row.email.trim())) rowErrors.push("email is missing or invalid");
    const amount = Number(row.amount);
    if (!row.amount.trim() || !Number.isFinite(amount) || amount < 0) rowErrors.push("amount is missing or invalid");
    if (rowErrors.length > 0) errors.push(`Row ${index + 2}: ${rowErrors.join("; ")}`);
    else validRecords += 1;
  });
  return { rows, errors, totalRecords: rows.length, validRecords, invalidRecords: rows.length - validRecords };
}

function cleanRows(rows: Array<Record<string, string>>): Array<Record<string, string>> {
  const unique = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const customerId = row.customer_id.trim();
    if (!customerId || unique.has(customerId)) continue;
    const numericAmount = Number(row.amount);
    unique.set(customerId, {
      customer_id: customerId,
      name: row.name.trim() || "Unknown",
      email: isValidEmail(row.email.trim()) ? row.email.trim().toLowerCase() : "unknown@example.com",
      amount: Number.isFinite(numericAmount) && numericAmount >= 0 ? numericAmount.toFixed(2) : "0.00",
      region: row.region.trim().toUpperCase() || "UNKNOWN",
    });
  }
  return [...unique.values()];
}

async function applyFailureScenario(config: Record<string, unknown>, attempt: number, signal: AbortSignal) {
  const scenario = config.scenario as FailureScenario | undefined;
  const taskId = config.taskId;
  if (scenario === "permanent_failure" && taskId === "data-fetch") {
    throw new TaskExecutionError("Configured permanent external-service failure.");
  }
  if (scenario === "independent_branch_failure" && taskId === "health-check") {
    throw new TaskExecutionError("Configured independent health-check failure.");
  }
  if (scenario === "temporary_failure" && taskId === "data-fetch" && attempt === 1) {
    throw new TaskExecutionError("Temporary external-service failure; retrying.");
  }
  const probability = config.failureProbability;
  if (typeof probability === "number" && probability > 0 && Math.random() < probability) {
    throw new TaskExecutionError("Random transient failure.");
  }
  const delay = config.artificialDelayMs;
  if (typeof delay === "number" && delay > 0) {
    await new Promise<void>((resolveDelay, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("Task aborted."));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolveDelay();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Task aborted."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export const templateHandlers: Record<string, TaskHandler> = {
  "csv-input": async ({ task }) => {
    const csvContent = task.config?.csvContent;
    if (typeof csvContent === "string") {
      try {
        return parseCsv(csvContent);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TaskExecutionError(`Uploaded CSV could not be parsed: ${message}`, false);
      }
    }
    const filePath = task.config?.filePath;
    if (typeof filePath !== "string") throw new TaskExecutionError("Sample CSV path is not configured.", false);
    try {
      return parseCsv(await readFile(filePath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskExecutionError(`Sample CSV could not be read: ${message}`, false);
    }
  },
  "csv-validate": ({ inputs }) => {
    const source = Object.values(inputs)[0];
    return validateRows(asRows(source));
  },
  "csv-clean": ({ inputs }) => {
    const validation = Object.values(inputs)[0] as ReturnType<typeof validateRows>;
    if (!validation || !Array.isArray(validation.rows)) throw new TaskExecutionError("Validation result is missing.", false);
    return { ...validation, rows: cleanRows(validation.rows) };
  },
  "csv-analyze": ({ inputs }) => {
    const cleaned = Object.values(inputs)[0] as ReturnType<typeof validateRows>;
    if (!cleaned || !Array.isArray(cleaned.rows)) throw new TaskExecutionError("Cleaned CSV rows are missing.", false);
    const amounts = cleaned.rows.map((row) => Number(row.amount));
    const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0);
    return {
      ...cleaned,
      statistics: {
        totalRecords: cleaned.totalRecords,
        validRecords: cleaned.validRecords,
        invalidRecords: cleaned.invalidRecords,
        exportedRecords: cleaned.rows.length,
        totalAmount: Number(totalAmount.toFixed(2)),
        averageAmount: amounts.length ? Number((totalAmount / amounts.length).toFixed(2)) : 0,
      },
    };
  },
  "csv-export": async ({ task, inputs }) => {
    const analysis = Object.values(inputs)[0] as ReturnType<typeof validateRows> & {
      statistics: Record<string, number>;
    };
    if (!analysis || !Array.isArray(analysis.rows)) throw new TaskExecutionError("Analysis result is missing.", false);
    const executionKey = task.config?.executionKey;
    if (typeof executionKey !== "string" || !/^[\w-]+$/.test(executionKey)) {
      throw new TaskExecutionError("CSV export identifier is invalid.", false);
    }
    await mkdir(CSV_EXPORT_DIRECTORY, { recursive: true });
    const filePath = resolve(CSV_EXPORT_DIRECTORY, `${executionKey}.csv`);
    await writeFile(filePath, stringifyCsv(analysis.rows, ["customer_id", "name", "email", "amount", "region"]), "utf8");
    return { filename: `${executionKey}.csv`, records: analysis.rows.length, statistics: analysis.statistics };
  },
  "text-input": ({ task }) => task.config?.text,
  "text-validate": ({ inputs }) => {
    const text = Object.values(inputs)[0];
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new TaskExecutionError("Text input must not be empty.", false);
    }
    if (text.length > MAX_TEXT_INPUT_LENGTH) {
      throw new TaskExecutionError(`Text input exceeds the ${MAX_TEXT_INPUT_LENGTH} character limit.`, false);
    }
    return { text: text.trim() };
  },
  "text-analyze": ({ inputs }) => {
    const validation = Object.values(inputs)[0] as { text?: string };
    if (typeof validation?.text !== "string") throw new TaskExecutionError("Validated text is missing.", false);
    const text = validation.text;
    const words = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
    const sentences = splitSentences(text);
    const frequencies = new Map<string, number>();
    for (const word of words) {
      const normalized = normalizeKeyword(word);
      if (!TEXT_STOP_WORDS.has(normalized) && !/^\p{N}+$/u.test(normalized)) {
        frequencies.set(normalized, (frequencies.get(normalized) ?? 0) + 1);
      }
    }
    const keywordFrequencies = frequencies.size > 0
      ? frequencies
      : words.reduce((fallback, word) => {
        const normalized = normalizeKeyword(word);
        if (!/^\p{N}+$/u.test(normalized)) {
          fallback.set(normalized, (fallback.get(normalized) ?? 0) + 1);
        }
        return fallback;
      }, new Map<string, number>());
    const topTerms = [...keywordFrequencies]
      .sort(([leftWord, leftCount], [rightWord, rightCount]) =>
        rightCount - leftCount || leftWord.localeCompare(rightWord))
      .slice(0, 10)
      .map(([word, count]) => ({ word, count }));
    const summary = sentences
      .map((sentence, index) => {
        const sentenceWords = sentence.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
        const score = sentenceWords.reduce(
          (total, word) => total + (frequencies.get(normalizeKeyword(word)) ?? 0),
          0,
        ) / Math.sqrt(Math.max(sentenceWords.length, 1));
        return { sentence, index, score };
      })
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 2)
      .sort((left, right) => left.index - right.index)
      .map(({ sentence }) => sentence)
      .join(" ");
    return {
      characters: text.length,
      charactersWithoutWhitespace: text.replace(/\s/gu, "").length,
      words: words.length,
      sentences: sentences.length || (words.length > 0 ? 1 : 0),
      averageSentenceLength: Number((words.length / Math.max(sentences.length, 1)).toFixed(1)),
      paragraphs: text.split(/\n\s*\n/u).filter((paragraph) => paragraph.trim().length > 0).length,
      topTerms,
      keywordFrequency: topTerms,
      topics: topTerms.slice(0, 5).map(({ word }) => word),
      summary: summary || text,
      validationIssues: [],
    };
  },
  "text-report": ({ inputs }) => {
    const statistics = Object.values(inputs)[0] as {
      characters: number;
      charactersWithoutWhitespace: number;
      words: number;
      sentences: number;
      averageSentenceLength: number;
      paragraphs: number;
      topTerms: Array<{ word: string; count: number }>;
      topics: string[];
      summary: string;
      validationIssues: string[];
    };
    if (!statistics || !Array.isArray(statistics.topTerms)) {
      throw new TaskExecutionError("Text analysis results are missing.", false);
    }
    return {
      generatedAt: new Date().toISOString(),
      summary: statistics.summary,
      topics: statistics.topics,
      validationIssues: statistics.validationIssues,
      statistics,
    };
  },
  "resilience-start": ({ task }) => ({ started: true, scenario: task.config?.scenario ?? "none" }),
  "resilience-fetch": async ({ task, attempt, signal }) => {
    const config = { ...task.config, taskId: task.id };
    await applyFailureScenario(config, attempt, signal);
    return { source: "sample external service", records: [{ id: 1, value: "alpha" }, { id: 2, value: "beta" }] };
  },
  "resilience-validate": async ({ task, inputs, attempt, signal }) => {
    await applyFailureScenario({ ...task.config, taskId: task.id }, attempt, signal);
    const data = Object.values(inputs)[0] as { records?: unknown[] };
    if (!Array.isArray(data?.records)) throw new TaskExecutionError("Fetched records are invalid.", false);
    return { records: data.records, valid: true, count: data.records.length };
  },
  "resilience-process": async ({ task, inputs, attempt, signal }) => {
    await applyFailureScenario({ ...task.config, taskId: task.id }, attempt, signal);
    const data = Object.values(inputs)[0] as { records: Array<Record<string, unknown>> };
    return data.records.map((record) => ({ ...record, processed: true }));
  },
  "resilience-report": async ({ task, inputs, attempt, signal }) => {
    await applyFailureScenario({ ...task.config, taskId: task.id }, attempt, signal);
    const records = Object.values(inputs)[0] as unknown[];
    return { generated: true, recordCount: records.length, generatedAt: new Date().toISOString() };
  },
  "resilience-health": async ({ task, attempt, signal }) => {
    await applyFailureScenario({ ...task.config, taskId: task.id }, attempt, signal);
    return { healthy: true, checkedAt: new Date().toISOString() };
  },
};

export function getCsvExportPath(executionId: string): string | undefined {
  if (!/^[\w-]+:[\w-]+$/.test(executionId)) return undefined;
  const [templateId, key] = executionId.split(":");
  if (templateId !== "csv-processing") return undefined;
  return resolve(CSV_EXPORT_DIRECTORY, `${key}.csv`);
}
