import { describe, test, expect } from "vitest";
import { generateEntries, type GeneratedEntry } from "@laranja/runtime";
import type { InfraIR } from "@laranja/core";

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
