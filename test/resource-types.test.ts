import { describe, test, expect, afterEach } from "vitest";
import { scan, generateResourceTypes, generateResourceTypesStub, resourceIds } from "@alzulejos/laranja-scanner";
import { makeProject, cleanupProjects, cfg } from "./helpers.js";

afterEach(cleanupProjects);

describe("resource types generation", () => {
  test("resourceIds collects http, cron ids, and queue names (sorted, deduped)", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@alzulejos/laranja-decorators";
        export default http(express());
      `,
      "src/jobs.ts": `
        import { cron, queue, rate } from "@alzulejos/laranja-decorators";
        export async function cleanup() {}
        export async function work() {}
        cron(rate(1, "hour"), cleanup);
        queue({ name: "orders" }, work);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg() });
    expect(resourceIds(ir)).toEqual(["cleanup", "http", "orders"]);
  });

  test("generateResourceTypes emits per-kind id unions of the real ids", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { cron, queue, rate } from "@alzulejos/laranja-decorators";
        export async function work() {}
        export async function cleanup() {}
        queue({ name: "orders" }, work);
        cron(rate(1, "hour"), cleanup);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    const out = generateResourceTypes(ir);
    expect(out).toContain('export type QueueResourceId = "orders";');
    expect(out).toContain('export type CronResourceId = "cleanup";');
    expect(out).toContain("export type HttpResourceId = never;");
    expect(out).toContain(
      "export type ResourceId = HttpResourceId | CronResourceId | QueueResourceId;",
    );
    expect(out).toContain("export type TypedLaranjaConfig");
    // The DLQ target is bound to the queue-name union so `dlq.queue` autocompletes.
    expect(out).toContain("CronResourceConfig<QueueResourceId>");
    expect(out).toContain("QueueResourceConfig<QueueResourceId>");
  });

  test("the init stub is permissive (per-kind ids = string)", () => {
    const stub = generateResourceTypesStub();
    expect(stub).toContain("export type HttpResourceId = string;");
    expect(stub).toContain("export type CronResourceId = string;");
    expect(stub).toContain("export type QueueResourceId = string;");
  });
});
