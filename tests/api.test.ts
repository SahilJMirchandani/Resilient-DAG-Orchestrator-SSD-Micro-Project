import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { existsSync, unlinkSync } from "node:fs";
import { createApp } from "../src/app.js";
import { templateHandlers } from "../src/templates.js";
import { WorkflowEngine } from "../src/engine.js";
import { ExecutionStore } from "../src/store.js";
import { getCsvExportPath } from "../src/templates.js";

const stores: ExecutionStore[] = [];
const exportPaths: string[] = [];
function makeApi() {
  const store = new ExecutionStore();
  stores.push(store);
  const engine = new WorkflowEngine({ store, handlers: templateHandlers });
  return { api: request(createApp(engine)), engine, store };
}

async function waitForExecution(store: ExecutionStore, executionId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const execution = store.getExecution(executionId);
    if (execution && execution.status !== "RUNNING") return execution;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Execution ${executionId} did not finish in time.`);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of exportPaths.splice(0)) if (existsSync(path)) unlinkSync(path);
});

describe("template execution API", () => {
  it("serves exactly three fixed templates and rejects unknown API routes", async () => {
    const { api } = makeApi();
    const templates = await api.get("/api/templates/");
    expect(templates.status).toBe(200);
    expect(templates.body.map((template: { id: string }) => template.id))
      .toEqual(["csv-processing", "resilience-recovery", "text-analysis"]);
    expect((await api.get("/api/templates/csv-processing")).body.nodes).toHaveLength(5);
    expect((await api.get("/api/templates/text-analysis")).body.nodes).toHaveLength(4);
    expect((await api.get("/api/templates/unknown")).status).toBe(404);
    expect((await api.get("/api/not-a-route")).body).toEqual({ error: "API route not found." });
    expect((await api.get("/api/executions?limit=50&offset=0")).status).toBe(200);
    expect((await api.get("/api/executions?limit=0")).status).toBe(400);
  });

  it("processes a user-uploaded CSV including a UTF-8 BOM and exports its records", async () => {
    const { api, store } = makeApi();
    const csvContent = "\uFEFFcustomer_id,name,email,amount,region\r\nC-1,Jane,jane@example.com,12.5,west\r\n";
    const started = await api.post("/api/executions").send({
      templateId: "csv-processing",
      input: { csvContent },
    });
    expect(started.status).toBe(202);
    const result = await waitForExecution(store, started.body.executionId);
    expect(result.status).toBe("SUCCESS");
    const rows = result.tasks.find((task) => task.taskId === "csv-input")?.output;
    expect(rows).toEqual([{
      customer_id: "C-1", name: "Jane", email: "jane@example.com", amount: "12.5", region: "west",
    }]);
    const exportPath = getCsvExportPath(store.getWorkflowForExecution(result.id)!.id)!;
    exportPaths.push(exportPath);
    const download = await api.get(`/api/executions/${result.id}/output`);
    expect(download.status).toBe(200);
    expect(download.text).toContain("C-1,Jane,jane@example.com,12.50,WEST");
  });

  it("runs the fixed text-analysis workflow on required user input", async () => {
    const { api, store } = makeApi();
    expect((await api.post("/api/executions").send({ templateId: "text-analysis" })).status).toBe(400);
    expect((await api.post("/api/executions").send({
      templateId: "text-analysis",
      input: { text: "   " },
    })).status).toBe(400);

    const started = await api.post("/api/executions").send({
      templateId: "text-analysis",
      input: { text: "Hello world. Hello DAG!\n\nAnother sentence." },
    });
    expect(started.status).toBe(202);
    const result = await waitForExecution(store, started.body.executionId);
    expect(result.workflowName).toBe("Text Analysis Pipeline");
    expect(result.status).toBe("SUCCESS");
    expect(result.tasks.map((task) => task.taskId)).toEqual([
      "text-input", "text-validation", "text-analysis", "text-report",
    ]);
    const analysis = result.tasks.find((task) => task.taskId === "text-analysis")?.output as {
      words: number;
      sentences: number;
      averageSentenceLength: number;
      paragraphs: number;
      topTerms: Array<{ word: string; count: number }>;
      keywordFrequency: Array<{ word: string; count: number }>;
      topics: string[];
      validationIssues: string[];
    };
    expect(analysis).toMatchObject({
      words: 6,
      sentences: 3,
      averageSentenceLength: 2,
      paragraphs: 2,
      validationIssues: [],
    });
    expect(analysis.topics).toEqual(expect.arrayContaining(["hello", "dag", "world"]));
    expect(analysis.topTerms[0]).toEqual({ word: "hello", count: 2 });
    expect(analysis.keywordFrequency[0]).toEqual({ word: "hello", count: 2 });
    expect(result.tasks.find((task) => task.taskId === "text-report")?.output)
      .toMatchObject({ summary: "Hello world. Hello DAG!", validationIssues: [] });
  });

  it("reports keyword frequencies and average sentence length for stop-word-only text", async () => {
    const { api, store } = makeApi();
    const started = await api.post("/api/executions").send({
      templateId: "text-analysis",
      input: { text: "the and of to is in the" },
    });
    expect(started.status).toBe(202);
    const result = await waitForExecution(store, started.body.executionId);
    const analysis = result.tasks.find((task) => task.taskId === "text-analysis")?.output as {
      words: number;
      sentences: number;
      averageSentenceLength: number;
      keywordFrequency: Array<{ word: string; count: number }>;
      topics: string[];
    };

    expect(analysis).toMatchObject({
      words: 7,
      sentences: 1,
      averageSentenceLength: 7,
    });
    expect(analysis.keywordFrequency[0]).toEqual({ word: "the", count: 2 });
    expect(analysis.topics[0]).toBe("the");
    expect(analysis.topics.length).toBeGreaterThan(0);
  });

  it("rejects malformed or oversized CSV uploads", async () => {
    const { api } = makeApi();
    expect((await api.post("/api/executions").send({
      templateId: "csv-processing",
      input: { csvContent: '"unterminated' },
    })).status).toBe(400);
    expect((await api.post("/api/executions").send({
      templateId: "csv-processing",
      input: { csvContent: `a,${"x".repeat(512 * 1024)}` },
    })).status).toBe(400);
  });

  it("runs the actual CSV pipeline, reports validation and writes a downloadable export", async () => {
    const { api, store } = makeApi();
    const started = await api.post("/api/executions").send({ templateId: "csv-processing" });
    expect(started.status).toBe(202);
    const result = await waitForExecution(store, started.body.executionId);
    expect(result.status).toBe("SUCCESS");
    expect(result.tasks.map((task) => task.taskId)).toEqual([
      "csv-input", "data-validation", "data-cleaning", "data-analysis", "csv-export",
    ]);
    expect(result.tasks.every((task) => task.status === "SUCCESS")).toBe(true);

    const validation = result.tasks.find((task) => task.taskId === "data-validation")?.output as {
      totalRecords: number; validRecords: number; invalidRecords: number; errors: string[];
    };
    expect(validation).toMatchObject({ totalRecords: 7, validRecords: 4, invalidRecords: 3 });
    expect(validation.errors).toHaveLength(3);

    const exportPath = getCsvExportPath(store.getWorkflowForExecution(result.id)!.id)!;
    exportPaths.push(exportPath);
    const download = await api.get(`/api/executions/${result.id}/output`);
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toContain("text/csv");
    expect(download.text).toContain("customer_id,name,email,amount,region");
    expect(download.text).toContain("ALICE@example.com".toLowerCase());
    expect((await api.get(`/api/executions/${result.id}/tasks`)).body).toHaveLength(5);
    expect((await api.get(`/api/executions/${result.id}/logs`)).body.length).toBeGreaterThan(0);
  });

  it("retries temporary failures and persists attempt and circuit-transition logs", async () => {
    const { api, store } = makeApi();
    const started = await api.post("/api/executions").send({
      templateId: "resilience-recovery",
      parameters: { scenario: "temporary_failure", maxAttempts: 3 },
    });
    expect(started.status).toBe(202);
    const result = await waitForExecution(store, started.body.executionId);
    expect(result.status).toBe("SUCCESS");
    expect(result.tasks.find((task) => task.taskId === "data-fetch")?.attempts).toBe(2);
    const logs = await api.get(`/api/executions/${result.id}/logs`);
    expect(logs.body.some((log: { message: string }) => log.message.includes("retrying after"))).toBe(true);
    const transitions = logs.body
      .filter((log: { message: string }) => log.message.includes("transitioned"))
      .map((log: { message: string }) => log.message);
    expect(transitions.some((message: string) => message.includes("CLOSED -> OPEN"))).toBe(true);
    expect(transitions.some((message: string) => message.includes("OPEN -> HALF_OPEN"))).toBe(true);
    expect(transitions.some((message: string) => message.includes("HALF_OPEN -> CLOSED"))).toBe(true);
    expect((await api.get("/api/dashboard/stats")).body.totalExecutions).toBe(1);
  });

  it("opens the external service breaker, exhausts permanent retries, and preserves the health branch", async () => {
    const { api, store } = makeApi();
    const started = await api.post("/api/executions").send({
      templateId: "resilience-recovery",
      parameters: { scenario: "permanent_failure", maxAttempts: 3 },
    });
    expect(started.status).toBe(202);
    const result = await waitForExecution(store, started.body.executionId);
    expect(result.status).toBe("PARTIAL");
    expect(result.tasks.find((task) => task.taskId === "data-fetch")?.attempts).toBe(3);
    expect(result.tasks.find((task) => task.taskId === "data-validation")?.status).toBe("SKIPPED");
    expect(result.tasks.find((task) => task.taskId === "health-check")?.status).toBe("SUCCESS");
    const logs = (await api.get(`/api/executions/${result.id}/logs`)).body as Array<{ message: string }>;
    expect(logs.some((log) => log.message.includes("CLOSED -> OPEN"))).toBe(true);
  });

  it("times out slow tasks while the independent branch continues", async () => {
    const { api, store } = makeApi();
    const started = await api.post("/api/executions").send({
      templateId: "resilience-recovery",
      parameters: { scenario: "slow_task", taskTimeoutMs: 30, maxAttempts: 1 },
    });
    expect(started.status).toBe(202);
    const result = await waitForExecution(store, started.body.executionId);
    expect(result.status).toBe("PARTIAL");
    expect(result.tasks.find((task) => task.taskId === "data-fetch")?.status).toBe("TIMED_OUT");
    expect(result.tasks.find((task) => task.taskId === "data-validation")?.status).toBe("SKIPPED");
    expect(result.tasks.find((task) => task.taskId === "health-check")?.status).toBe("SUCCESS");
  });

  it("isolates independent branch failures and validates execution parameters", async () => {
    const { api, store } = makeApi();
    expect((await api.post("/api/executions").send({ templateId: "custom" })).status).toBe(400);
    expect((await api.post("/api/executions").send({
      templateId: "resilience-recovery",
      parameters: { scenario: "slow_task", taskTimeoutMs: 0 },
    })).status).toBe(400);
    expect((await api.post("/api/executions").send({
      templateId: "resilience-recovery",
      parameters: { scenario: "slow_task", taskTimeoutMs: 2_147_483_647 },
    })).status).toBe(400);
    expect((await api.post("/api/executions").send({
      templateId: "resilience-recovery",
      parameters: { failureProbability: 2 },
    })).status).toBe(400);

    const started = await api.post("/api/executions").send({
      templateId: "resilience-recovery",
      parameters: { scenario: "independent_branch_failure", maxAttempts: 1 },
    });
    const result = await waitForExecution(store, started.body.executionId);
    expect(result.status).toBe("PARTIAL");
    expect(result.tasks.find((task) => task.taskId === "health-check")?.status).toBe("FAILED");
    expect(result.tasks.find((task) => task.taskId === "report-generation")?.status).toBe("SUCCESS");
  });
});
