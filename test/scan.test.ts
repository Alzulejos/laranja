import { describe, test, expect, afterEach } from "vitest";
import { scan } from "@laranja/scanner";
import { makeProject, cleanupProjects, cfg } from "./helpers.js";

afterEach(cleanupProjects);

describe("class / decorator style", () => {
  test("discovers @Cron and @Queue as method-style handlers", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron, Queue, rate } from "@laranja/decorators";
        export class Jobs {
          @Cron(rate(5, "minutes"))
          async refreshCache() {}
          @Queue({ name: "emails", batchSize: 10 })
          async sendEmails() {}
        }
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });

    expect(ir.crons).toHaveLength(1);
    expect(ir.crons[0]).toMatchObject({
      style: "method",
      className: "Jobs",
      method: "refreshCache",
      id: "Jobs-refreshCache",
      schedule: "rate(5 minutes)",
    });
    expect(ir.queues[0]).toMatchObject({
      style: "method",
      className: "Jobs",
      method: "sendEmails",
      name: "emails",
      batchSize: 10,
    });
  });

  test("honors an explicit @Cron id and folds every()", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron, every } from "@laranja/decorators";
        export class Jobs {
          @Cron({ schedule: every("day"), id: "nightly" })
          async run() {}
        }
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.crons[0]).toMatchObject({ id: "nightly", schedule: "rate(1 day)" });
  });
});

describe("function / marker style", () => {
  test("discovers cron() and queue() as function-style handlers", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, queue, rate } from "@laranja/decorators";
        export async function refreshCache() {}
        export async function sendEmails() {}
        cron(rate(5, "minutes"), refreshCache);
        queue({ name: "orders.fifo" }, sendEmails);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });

    expect(ir.crons[0]).toMatchObject({
      style: "function",
      exportName: "refreshCache",
      id: "refreshCache",
      schedule: "rate(5 minutes)",
    });
    expect(ir.queues[0]).toMatchObject({
      style: "function",
      exportName: "sendEmails",
      name: "orders.fifo",
      fifo: true, // inferred from the .fifo suffix
    });
  });

  test("resolves aliased imports", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron as schedule, rate } from "@laranja/decorators";
        export async function tick() {}
        schedule(rate(1, "hour"), tick);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.crons[0]).toMatchObject({ style: "function", exportName: "tick" });
  });

  test("rejects a handler that is not exported", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, rate } from "@laranja/decorators";
        async function notExported() {}
        cron(rate(5, "minutes"), notExported);
      `,
    });
    expect(() => scan({ projectDir: dir, config: cfg({ http: false }) })).toThrow(/must be exported/);
  });
});

describe("http app resolution", () => {
  test("a default-exported http() marker sets appExport to 'default'", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@laranja/decorators";
        const app = express();
        app.get("/", (_req, res) => res.json({ ok: true }));
        export default http(app);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg() });
    expect(ir.http).toMatchObject({ handlerEntry: "src/app.ts", appExport: "default" });
    expect(ir.http?.routes).toHaveLength(1);
  });

  test("a named-export http() marker uses that export name", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@laranja/decorators";
        export const api = http(express());
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg() });
    expect(ir.http?.appExport).toBe("api");
  });

  test("falls back to config entry/appExport when there is no marker", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        export const app = express();
        app.get("/health", (_req, res) => res.json({ ok: true }));
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ entry: "src/app.ts", appExport: "app" }) });
    expect(ir.http).toMatchObject({ handlerEntry: "src/app.ts", appExport: "app" });
  });

  test("http: false disables HTTP even with jobs present", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, rate } from "@laranja/decorators";
        export async function tick() {}
        cron(rate(1, "hour"), tick);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    expect(ir.http).toBeUndefined();
    expect(ir.crons).toHaveLength(1);
  });

  test("errors on more than one http() marker", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@laranja/decorators";
        export const a = http(express());
        export const b = http(express());
      `,
    });
    expect(() => scan({ projectDir: dir, config: cfg() })).toThrow(/only one HTTP app/);
  });

  test("errors when the http() marker is not exported", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@laranja/decorators";
        const app = http(express());
      `,
    });
    expect(() => scan({ projectDir: dir, config: cfg() })).toThrow(/must be exported/);
  });
});

describe("nothing to deploy", () => {
  test("throws when there is no app and no handlers", () => {
    const dir = makeProject({
      "src/empty.ts": `export const noop = 1;`,
    });
    expect(() => scan({ projectDir: dir, config: cfg({ http: false }) })).toThrow(/Nothing to deploy/);
  });
});
