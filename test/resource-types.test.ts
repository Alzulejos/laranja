import { describe, test, expect, afterEach } from "vitest";
import { scan, generateResourceTypes, generateResourceTypesStub, resourceIds } from "@laranja/scanner";
import { makeProject, cleanupProjects, cfg } from "./helpers.js";

afterEach(cleanupProjects);

describe("resource types generation", () => {
  test("resourceIds collects http, cron ids, and queue names (sorted, deduped)", () => {
    const dir = makeProject({
      "src/app.ts": `
        import express from "express";
        import { http } from "@laranja/decorators";
        export default http(express());
      `,
      "src/jobs.ts": `
        import { cron, queue, rate } from "@laranja/decorators";
        export async function cleanup() {}
        export async function work() {}
        cron(rate(1, "hour"), cleanup);
        queue({ name: "orders" }, work);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg() });
    expect(resourceIds(ir)).toEqual(["cleanup", "http", "orders"]);
  });

  test("generateResourceTypes emits a ResourceId union of the real ids", () => {
    const dir = makeProject({
      "src/jobs.ts": `
        import { queue } from "@laranja/decorators";
        export async function work() {}
        queue({ name: "orders" }, work);
      `,
    });
    const ir = scan({ projectDir: dir, config: cfg({ http: false }) });
    const out = generateResourceTypes(ir);
    expect(out).toContain('export type ResourceId = "orders";');
    expect(out).toContain("export type TypedLaranjaConfig");
  });

  test("the init stub is permissive (ResourceId = string)", () => {
    expect(generateResourceTypesStub()).toContain("export type ResourceId = string;");
  });
});
