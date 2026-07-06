import { describe, test, expect } from "vitest";
import { generateEntries, type GeneratedEntry } from "@alzulejos/laranja-runtime";
import type { InfraIR } from "@alzulejos/laranja-core";

// Synthetic, fixed paths keep the generated import specifiers (and thus snapshots)
// deterministic across machines — codegen emits paths relative to the entry dir.
const projectDir = "/proj";
const entryDir = "/proj/.laranja/entries";
const opts = { projectDir, entryDir };

function baseIR(overrides: Partial<InfraIR> = {}): InfraIR {
  return {
    app: { name: "app", framework: "express", stage: "dev", entry: "src/app.ts" },
    http: undefined,
    crons: [],
    queues: [],
    env: { STAGE: "dev" },
    ...overrides,
  };
}

const byId = (entries: GeneratedEntry[], id: string) => entries.find((e) => e.id === id)!;

describe("http shim", () => {
  test("default export imports the default binding", () => {
    const entries = generateEntries(
      baseIR({ http: { handlerEntry: "src/app.ts", appExport: "default", routes: [] } }),
      opts,
    );
    const http = byId(entries, "http");
    expect(http.kind).toBe("http");
    expect(http.contents).toContain(`import app from "../../src/app";`);
    expect(http.contents).toContain(`createHttpHandler(app)`);
  });

  test("named export 'app' imports it directly", () => {
    const entries = generateEntries(
      baseIR({ http: { handlerEntry: "src/app.ts", appExport: "app", routes: [] } }),
      opts,
    );
    expect(byId(entries, "http").contents).toContain(`import { app } from "../../src/app";`);
  });

  test("other named export is aliased to app", () => {
    const entries = generateEntries(
      baseIR({ http: { handlerEntry: "src/server.ts", appExport: "api", routes: [] } }),
      opts,
    );
    expect(byId(entries, "http").contents).toContain(`import { api as app } from "../../src/server";`);
  });

  test("no http shim is emitted when http is absent", () => {
    const entries = generateEntries(baseIR(), opts);
    expect(entries.find((e) => e.kind === "http")).toBeUndefined();
  });
});

describe("cron shim", () => {
  test("method style imports the class and passes the method name", () => {
    const entries = generateEntries(
      baseIR({
        crons: [
          {
            style: "method",
            id: "Jobs-refreshCache",
            schedule: "rate(5 minutes)",
            file: "src/jobs.ts",
            className: "Jobs",
            method: "refreshCache",
            source: "src/jobs.ts:3",
          },
        ],
      }),
      opts,
    );
    const shim = byId(entries, "Jobs-refreshCache");
    expect(shim.contents).toContain(`import { Jobs } from "../../src/jobs";`);
    expect(shim.contents).toContain(`createScheduledHandler(Jobs, "refreshCache")`);
  });

  test("function style imports and wraps the exported function", () => {
    const entries = generateEntries(
      baseIR({
        crons: [
          {
            style: "function",
            id: "refreshCache",
            schedule: "rate(5 minutes)",
            file: "src/jobs.ts",
            exportName: "refreshCache",
            source: "src/jobs.ts:3",
          },
        ],
      }),
      opts,
    );
    const shim = byId(entries, "refreshCache");
    expect(shim.contents).toContain(`import { refreshCache } from "../../src/jobs";`);
    expect(shim.contents).toContain(`createScheduledHandler(refreshCache)`);
  });
});

describe("queue shim", () => {
  test("function style wraps the exported consumer", () => {
    const entries = generateEntries(
      baseIR({
        queues: [
          {
            style: "function",
            id: "sendEmails",
            name: "emails",
            file: "src/jobs.ts",
            exportName: "sendEmails",
            source: "src/jobs.ts:5",
          },
        ],
      }),
      opts,
    );
    const shim = byId(entries, "sendEmails");
    expect(shim.contents).toContain(`import { sendEmails } from "../../src/jobs";`);
    expect(shim.contents).toContain(`createQueueHandler(sendEmails)`);
  });
});

describe("full output snapshot", () => {
  test("mixed app + cron + queue generates a stable set of shims", () => {
    const entries = generateEntries(
      baseIR({
        http: { handlerEntry: "src/app.ts", appExport: "default", routes: [] },
        crons: [
          {
            style: "function",
            id: "refreshCache",
            schedule: "rate(5 minutes)",
            file: "src/jobs.ts",
            exportName: "refreshCache",
            source: "src/jobs.ts:3",
          },
        ],
        queues: [
          {
            style: "method",
            id: "Jobs-sendEmails",
            name: "emails",
            file: "src/jobs.ts",
            className: "Jobs",
            method: "sendEmails",
            source: "src/jobs.ts:5",
          },
        ],
      }),
      opts,
    );
    expect(entries.map((e) => ({ id: e.id, kind: e.kind, fileName: e.fileName, contents: e.contents }))).toMatchSnapshot();
  });
});

describe("nest worker shim (DI)", () => {
  const nestOpts = {
    projectDir,
    entryDir,
    resolveCompiled: (file: string) => "/proj/dist/" + file.replace(/^src\//, "").replace(/\.ts$/, ".js"),
  };
  const nestIR = (overrides: Partial<InfraIR> = {}) =>
    baseIR({
      app: { name: "app", framework: "nest", stage: "dev", entry: "src/main.ts" },
      workers: [{ id: "AppModule", handlerEntry: "src/app.module.ts", appExport: "default" }],
      ...overrides,
    });

  test("a module's crons + queues become ONE worker dispatcher Lambda", () => {
    const entries = generateEntries(
      nestIR({
        crons: [
          {
            style: "method",
            id: "Tasks-sweep",
            schedule: "rate(5 minutes)",
            file: "src/tasks/tasks.service.ts",
            className: "TasksService",
            method: "sweep",
            source: "src/tasks/tasks.service.ts:9",
            workersId: "AppModule",
          },
        ],
        queues: [
          {
            style: "method",
            id: "Mailer-send",
            name: "emails",
            file: "src/mailer.ts",
            className: "Mailer",
            method: "send",
            source: "src/mailer.ts:5",
            workersId: "AppModule",
          },
        ],
      }),
      nestOpts,
    );
    // One Lambda for the module, keyed by the module id — not per handler.
    expect(entries.map((e) => e.id).sort()).toEqual(["AppModule"]);
    const shim = byId(entries, "AppModule");
    expect(shim.kind).toBe("worker");
    expect(shim.contents).toContain(`import { NestFactory } from "@nestjs/core";`);
    expect(shim.contents).toContain(`import workersModule from "../../dist/app.module";`);
    expect(shim.contents).toContain(`import { TasksService } from "../../dist/tasks/tasks.service";`);
    expect(shim.contents).toContain(`import { Mailer } from "../../dist/mailer";`);
    expect(shim.contents).toContain(`createNestWorkerDispatcher(`);
    expect(shim.contents).toContain(`() => NestFactory.createApplicationContext(workersModule)`);
    // Cron routed by id (the EventBridge input), queue routed by name (the SQS source).
    expect(shim.contents).toContain(`"Tasks-sweep": [TasksService, "sweep"]`);
    expect(shim.contents).toContain(`"emails": [Mailer, "send"]`);
  });

  test("a named workers export is imported by alias", () => {
    const entries = generateEntries(
      nestIR({
        workers: [{ id: "AppModule", handlerEntry: "src/app.module.ts", appExport: "jobs" }],
        crons: [
          {
            style: "method",
            id: "Tasks-sweep",
            schedule: "rate(5 minutes)",
            file: "src/tasks.service.ts",
            className: "TasksService",
            method: "sweep",
            source: "src/tasks.service.ts:9",
            workersId: "AppModule",
          },
        ],
      }),
      nestOpts,
    );
    expect(byId(entries, "AppModule").contents).toContain(
      `import { jobs as workersModule } from "../../dist/app.module";`,
    );
  });

  test("a function-style cron in a Nest app stays plain (no DI)", () => {
    const entries = generateEntries(
      nestIR({
        crons: [
          {
            style: "function",
            id: "refresh",
            schedule: "rate(5 minutes)",
            file: "src/jobs.ts",
            exportName: "refresh",
            source: "src/jobs.ts:3",
          },
        ],
      }),
      nestOpts,
    );
    const shim = byId(entries, "refresh");
    expect(shim.contents).toContain(`createScheduledHandler(refresh)`);
    expect(shim.contents).not.toContain("NestFactory");
  });

  test("multiple DI roots: each shim boots only its own workers module", () => {
    const entries = generateEntries(
      nestIR({
        workers: [
          { id: "QueueModule", handlerEntry: "src/queue/queue.module.ts", appExport: "default" },
          { id: "CronModule", handlerEntry: "src/cron/cron.module.ts", appExport: "default" },
        ],
        queues: [
          {
            style: "method",
            id: "EmailConsumer-handle",
            name: "emails",
            file: "src/queue/email.consumer.ts",
            className: "EmailConsumer",
            method: "handle",
            source: "src/queue/email.consumer.ts:3",
            workersId: "QueueModule",
          },
        ],
        crons: [
          {
            style: "method",
            id: "SweepService-sweep",
            schedule: "rate(5 minutes)",
            file: "src/cron/sweep.service.ts",
            className: "SweepService",
            method: "sweep",
            source: "src/cron/sweep.service.ts:3",
            workersId: "CronModule",
          },
        ],
      }),
      nestOpts,
    );
    // Each module is its own worker Lambda; neither drags in the other's DI graph.
    const queueShim = byId(entries, "QueueModule").contents;
    const cronShim = byId(entries, "CronModule").contents;
    expect(queueShim).toContain(`import workersModule from "../../dist/queue/queue.module";`);
    expect(queueShim).toContain(`"emails": [EmailConsumer, "handle"]`);
    expect(queueShim).not.toContain("cron.module");
    expect(cronShim).toContain(`import workersModule from "../../dist/cron/cron.module";`);
    expect(cronShim).toContain(`"SweepService-sweep": [SweepService, "sweep"]`);
    expect(cronShim).not.toContain("queue.module");
  });
});
