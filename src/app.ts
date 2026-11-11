import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { WorkflowValidationError } from "./dag.js";
import { WorkflowEngine } from "./engine.js";
import { parseCsv } from "./csv.js";
import {
  DEFAULT_RESILIENCE_OPTIONS,
  getCsvExportPath,
  getTemplate,
  listTemplates,
  MAX_CSV_UPLOAD_BYTES,
  MAX_TEXT_INPUT_LENGTH,
  TEMPLATE_IDS,
  createTemplateWorkflow,
  type FailureScenario,
  type ResilienceOptions,
  type TemplateInput,
  type TemplateId,
} from "./templates.js";
import { MAX_TASK_RETRIES, MAX_TASK_TIMER_MS } from "./types.js";

const failureScenarios = new Set<FailureScenario>([
  "none", "temporary_failure", "permanent_failure", "slow_task", "independent_branch_failure",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInteger(value: unknown, fallback: number, name: string, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WorkflowValidationError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseResilienceOptions(value: unknown): ResilienceOptions {
  if (value === undefined) return DEFAULT_RESILIENCE_OPTIONS;
  if (!isRecord(value)) throw new WorkflowValidationError("parameters must be an object.");
  const scenario = value.scenario ?? DEFAULT_RESILIENCE_OPTIONS.scenario;
  if (typeof scenario !== "string" || !failureScenarios.has(scenario as FailureScenario)) {
    throw new WorkflowValidationError("scenario must be one of the supported failure scenarios.");
  }
  const failureProbability = value.failureProbability ?? DEFAULT_RESILIENCE_OPTIONS.failureProbability;
  if (typeof failureProbability !== "number" || !Number.isFinite(failureProbability) ||
      failureProbability < 0 || failureProbability > 1) {
    throw new WorkflowValidationError("failureProbability must be between 0 and 1.");
  }
  const taskTimeoutMs = parseInteger(
    value.taskTimeoutMs, DEFAULT_RESILIENCE_OPTIONS.taskTimeoutMs, "taskTimeoutMs", 0, MAX_TASK_TIMER_MS,
  );
  const artificialDelayMs = parseInteger(
    value.artificialDelayMs, 0, "artificialDelayMs", 0, MAX_TASK_TIMER_MS,
  );
  if (scenario === "slow_task" && taskTimeoutMs === 0) {
    throw new WorkflowValidationError("slow_task requires a positive taskTimeoutMs.");
  }
  if (scenario === "slow_task" && taskTimeoutMs > MAX_TASK_TIMER_MS - 25) {
    throw new WorkflowValidationError("slow_task timeout must leave room for its delay within the supported timer range.");
  }
  return {
    scenario: scenario as FailureScenario,
    failureProbability,
    maxAttempts: parseInteger(value.maxAttempts, DEFAULT_RESILIENCE_OPTIONS.maxAttempts, "maxAttempts", 1, MAX_TASK_RETRIES + 1),
    taskTimeoutMs,
    artificialDelayMs,
  };
}

function parseTemplateInput(templateId: TemplateId, value: unknown): TemplateInput {
  if (value === undefined) {
    if (templateId === "text-analysis") {
      throw new WorkflowValidationError("Text input is required for the Text Analysis Pipeline.");
    }
    return {};
  }
  if (!isRecord(value)) throw new WorkflowValidationError("input must be an object.");

  if (templateId === "csv-processing" && value.csvContent !== undefined) {
    if (typeof value.csvContent !== "string") {
      throw new WorkflowValidationError("input.csvContent must contain CSV text.");
    }
    if (Buffer.byteLength(value.csvContent, "utf8") > MAX_CSV_UPLOAD_BYTES) {
      throw new WorkflowValidationError(`CSV uploads must be ${MAX_CSV_UPLOAD_BYTES / 1024} KB or smaller.`);
    }
    try {
      parseCsv(value.csvContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkflowValidationError(`CSV could not be parsed: ${message}`);
    }
    return { csvContent: value.csvContent };
  }

  if (templateId === "text-analysis") {
    if (typeof value.text !== "string" || value.text.trim().length === 0) {
      throw new WorkflowValidationError("Non-empty input.text is required for the Text Analysis Pipeline.");
    }
    if (value.text.length > MAX_TEXT_INPUT_LENGTH) {
      throw new WorkflowValidationError(`Text input must be ${MAX_TEXT_INPUT_LENGTH} characters or fewer.`);
    }
    return { text: value.text };
  }

  return {};
}

function notFound(response: Response, resource: string): void {
  response.status(404).json({ error: `${resource} not found.` });
}

export function createApp(engine: WorkflowEngine) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
  app.get("/api/templates", (_request, response) => response.json(listTemplates()));
  app.get("/api/templates/:id", (request, response) => {
    const template = getTemplate(request.params.id);
    if (!template) {
      notFound(response, "Template");
      return;
    }
    response.json(template);
  });

  app.post("/api/executions", (request, response) => {
    if (!isRecord(request.body) || typeof request.body.templateId !== "string" ||
        !TEMPLATE_IDS.includes(request.body.templateId as TemplateId)) {
      response.status(400).json({ error: "templateId must identify one of the available templates." });
      return;
    }
    const templateId = request.body.templateId as TemplateId;
    const input = parseTemplateInput(templateId, request.body.input);
    const options = templateId === "resilience-recovery"
      ? parseResilienceOptions(request.body.parameters)
      : undefined;
    const workflow = createTemplateWorkflow(templateId, randomUUID(), options, input);
    const executionId = engine.startWorkflow(workflow);
    response.status(202).json({ executionId, status: "RUNNING", templateId, workflowName: workflow.name });
  });

  app.get("/api/executions", (request, response) => {
    const limit = parseInteger(request.query.limit, 50, "limit", 1, 100);
    const offset = parseInteger(request.query.offset, 0, "offset", 0, 1_000_000);
    response.json(engine.store.listExecutions({ limit, offset }));
  });

  app.get("/api/executions/:id/tasks", (request, response) => {
    const execution = engine.getExecution(request.params.id);
    if (!execution) {
      notFound(response, "Execution");
      return;
    }
    response.json(execution.tasks);
  });

  app.get("/api/executions/:id/logs", (request, response) => {
    if (!engine.getExecution(request.params.id)) {
      notFound(response, "Execution");
      return;
    }
    response.json(engine.store.getLogs(request.params.id));
  });

  app.get("/api/executions/:id/output", (request, response) => {
    const execution = engine.getExecution(request.params.id);
    if (!execution) {
      notFound(response, "Execution");
      return;
    }
    const outputPath = getCsvExportPath(engine.store.getWorkflowForExecution(request.params.id)?.id ?? "");
    if (!outputPath) {
      notFound(response, "CSV export");
      return;
    }
    if (execution.status === "RUNNING") {
      response.status(409).json({ error: "CSV export is not ready yet." });
      return;
    }
    if (!existsSync(outputPath)) {
      notFound(response, "CSV export");
      return;
    }
    response.download(outputPath, "processed.csv");
  });

  app.get("/api/executions/:id", (request, response) => {
    const execution = engine.getExecution(request.params.id);
    if (!execution) {
      notFound(response, "Execution");
      return;
    }
    response.json(execution);
  });

  app.get("/api/dashboard/stats", (_request, response) => {
    response.json({
      ...engine.store.getMonitoringOverview(),
      recentExecutions: engine.store.listExecutions({ limit: 10 }),
      availableTemplates: listTemplates().map(({ id, name, description }) => ({ id, name, description })),
    });
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API route not found." });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request: Request, response: Response, _next) => {
    if (error instanceof WorkflowValidationError) {
      response.status(400).json({ error: error.message });
      return;
    }
    if (isRecord(error) && error.type === "entity.parse.failed") {
      response.status(400).json({ error: "Request body must contain valid JSON." });
      return;
    }
    if (isRecord(error) && error.type === "entity.too.large") {
      response.status(413).json({ error: "Request body exceeds the 1 MB limit." });
      return;
    }
    console.error(JSON.stringify({
      level: "error",
      message: error instanceof Error ? error.message : String(error),
    }));
    response.status(500).json({ error: "Internal server error." });
  };
  app.use(errorHandler);

  return app;
}
