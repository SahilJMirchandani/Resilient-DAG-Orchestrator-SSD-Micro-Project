import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";
import { builtInHandlers } from "./builtins.js";
import { WorkflowEngine } from "./engine.js";
import { ExecutionStore } from "./store.js";
import { templateHandlers } from "./templates.js";

const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/orchestrator.sqlite");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

mkdirSync(dirname(databasePath), { recursive: true });
const store = new ExecutionStore(databasePath);
const engine = await WorkflowEngine.create({ store, handlers: { ...builtInHandlers, ...templateHandlers } });
const app = createApp(engine);
const frontendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../frontend-dist");
if (existsSync(resolve(frontendDirectory, "index.html"))) {
  app.use(express.static(frontendDirectory));
  app.get("/", (_request, response) => response.sendFile(resolve(frontendDirectory, "index.html")));
}
const server = app.listen(port, () => {
  console.log(JSON.stringify({ level: "info", message: "API listening", port, databasePath }));
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
