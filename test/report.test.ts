import { describe, it, expect } from "vitest";
import type { InfraIR } from "../packages/core/src/ir.js";
import { buildDeployedResources } from "../packages/cli/src/report.js";

const region = "eu-west-1";
const account = "123456789012";

function makeIr(over: Partial<InfraIR> = {}): InfraIR {
  return {
    app: { name: "myapp", framework: "express", provider: "aws", stage: "dev", entry: "src/app.ts" },
    http: { handlerEntry: "src/app.ts", appExport: "app", routes: [{ method: "GET", path: "/", source: "src/app.ts:1" }] },
    crons: [],
    queues: [],
    env: {},
    envKeys: [],
    ...over,
  };
}

describe("buildDeployedResources", () => {
  it("reports one resource per http/cron/queue with correct names and types", () => {
    const ir = makeIr({
      crons: [
        { style: "function", file: "src/jobs.ts", exportName: "cleanup", source: "src/jobs.ts:1", id: "cleanup", schedule: { kind: "rate", value: 1, unit: "day" } },
      ],
      queues: [
        { style: "function", file: "src/q.ts", exportName: "processOrder", source: "src/q.ts:1", id: "orders", name: "orders-queue" },
      ],
    });

    const res = buildDeployedResources({
      ir,
      region,
      account,
      outputs: { HttpUrl: "https://abc.lambda-url.eu-west-1.on.aws/" },
      missingEnv: [],
    });

    expect(res.map((r) => [r.name, r.type])).toEqual([
      ["http", "http"],
      ["cleanup", "cron"],
      ["orders", "queue"],
    ]);
  });

  it("reconstructs Lambda ARNs from <app>-<label>-<stage> and carries the Function URL on http only", () => {
    const ir = makeIr({
      crons: [
        { style: "function", file: "src/jobs.ts", exportName: "cleanup", source: "src/jobs.ts:1", id: "cleanup", schedule: { kind: "rate", value: 1, unit: "day" } },
      ],
    });
    const res = buildDeployedResources({ ir, region, account, outputs: { HttpUrl: "https://url/" }, missingEnv: [] });

    const http = res.find((r) => r.type === "http")!;
    const cron = res.find((r) => r.type === "cron")!;
    expect(http.externalId).toBe("arn:aws:lambda:eu-west-1:123456789012:function:myapp-app-dev");
    expect(http.externalUrl).toBe("https://url/");
    expect(cron.externalId).toBe("arn:aws:lambda:eu-west-1:123456789012:function:myapp-cleanup-dev");
    expect(cron.externalUrl).toBeNull();
  });

  it("puts queue config in metadata and defaults metadata to {} (never null)", () => {
    const ir = makeIr({
      http: undefined,
      queues: [
        { style: "function", file: "src/q.ts", exportName: "processOrder", source: "src/q.ts:1", id: "orders", name: "orders.fifo", fifo: true, batchSize: 5 },
      ],
    });
    const [queue] = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [] });
    expect(queue.metadata).toEqual({
      queueName: "orders.fifo",
      fifo: true,
      batchSize: 5,
      queueArn: "arn:aws:sqs:eu-west-1:123456789012:orders.fifo",
    });
  });

  it("stores the structured schedule plus a ready-to-display description on cron metadata", () => {
    const ir = makeIr({
      http: undefined,
      crons: [
        { style: "function", file: "src/jobs.ts", exportName: "sweep", source: "src/jobs.ts:1", id: "sweep", schedule: { kind: "cron", expression: "* * * * ? *", dialect: "aws" } },
      ],
    });
    const [cron] = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [] });
    // The FE reads `description` directly; the structured schedule is kept alongside it.
    expect(cron.metadata).toEqual({
      schedule: { kind: "cron", expression: "* * * * ? *", dialect: "aws", description: "Every minute" },
    });
  });

  it("surfaces missing env keys as per-resource metadata.warnings", () => {
    const ir = makeIr();
    const [http] = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: ["STRIPE_KEY", "DB_URL"] });
    expect(http.metadata.warnings).toEqual(["STRIPE_KEY", "DB_URL"]);
    expect(http.externalUrl).toBeNull();
  });

  it("reports the full inventory every time (http + every cron + every queue)", () => {
    const ir = makeIr({
      crons: [
        { style: "function", file: "src/jobs.ts", exportName: "cleanup", source: "src/jobs.ts:1", id: "cleanup", schedule: { kind: "rate", value: 1, unit: "day" } },
      ],
      queues: [
        { style: "function", file: "src/q.ts", exportName: "processOrder", source: "src/q.ts:1", id: "orders", name: "orders-queue" },
      ],
    });
    const res = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [] });
    expect(res.map((r) => r.name)).toEqual(["http", "cleanup", "orders"]);
  });
});
