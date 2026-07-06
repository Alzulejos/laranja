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
    // Function-style handlers are standalone (their own Lambda) → compute + trigger.
    expect(out).toContain('type StandaloneQueueId = "orders";');
    expect(out).toContain('type StandaloneCronId = "cleanup";');
    expect(out).toContain("type GroupedCronId = never;");
    expect(out).toContain("export type HttpResourceId = never;");
    expect(out).toContain("export type WorkerId = never;");
    expect(out).toContain("export type CronResourceId = GroupedCronId | StandaloneCronId;");
    expect(out).toContain("export type QueueResourceId = GroupedQueueId | StandaloneQueueId;");
    expect(out).toContain(
      "export type ResourceId = HttpResourceId | WorkerId | CronResourceId | QueueResourceId;",
    );
    expect(out).toContain("export type TypedLaranjaConfig");
    // The DLQ target is bound to the queue-name union so `dlq.queue` autocompletes.
    expect(out).toContain("CronResourceConfig<QueueResourceId>");
    expect(out).toContain("QueueResourceConfig<QueueResourceId>");
  });

  test("grouped Nest handlers key compute on the worker, triggers on the handler", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { Cron, Queue, rate } from "@alzulejos/laranja-decorators";
        export class Jobs {
          @Cron(rate(5, "minutes")) async sweep() {}
          @Queue({ name: "emails" }) async send() {}
        }
      `,
      "src/app.module.ts": `
        import { Module } from "@nestjs/common";
        import { workers } from "@alzulejos/laranja-decorators";
        import { Jobs } from "./jobs";
        @Module({ providers: [Jobs] })
        class AppModule {}
        export default workers(AppModule);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ framework: "nest" }) });
    const out = generateResourceTypes(ir);
    expect(out).toContain('export type WorkerId = "AppModule";');
    expect(out).toContain('type GroupedCronId = "Jobs-sweep";');
    expect(out).toContain('type GroupedQueueId = "emails";');
    expect(out).toContain("type StandaloneCronId = never;");
    // Compute goes on the worker; grouped handlers take trigger-only configs.
    expect(out).toContain("Record<WorkerId, WorkerResourceConfig>");
    expect(out).toContain("Record<GroupedCronId, CronTriggerConfig<QueueResourceId>>");
    expect(out).toContain("Record<GroupedQueueId, QueueTriggerConfig<QueueResourceId>>");
  });

  test("the init stub is permissive (standalone ids = string)", () => {
    const stub = generateResourceTypesStub();
    expect(stub).toContain("export type HttpResourceId = string;");
    expect(stub).toContain("export type WorkerId = never;");
    expect(stub).toContain("type StandaloneCronId = string;");
    expect(stub).toContain("type StandaloneQueueId = string;");
  });
});
