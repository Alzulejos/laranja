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
      priorPhysicalIds: new Set(),
      priorNodeLambdas: [],
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
    const res = buildDeployedResources({ ir, region, account, outputs: { HttpUrl: "https://url/" }, missingEnv: [], priorPhysicalIds: new Set(), priorNodeLambdas: [] });

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
    const [queue] = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [], priorPhysicalIds: new Set(), priorNodeLambdas: [] });
    expect(queue.metadata).toEqual({
      queueName: "orders.fifo",
      fifo: true,
      batchSize: 5,
      queueArn: "arn:aws:sqs:eu-west-1:123456789012:orders.fifo",
    });
  });

  it("carries a queue's DLQ as an edge, translating the target's SQS name to its resource id", () => {
    const ir = makeIr({
      http: undefined,
      queues: [
        // dlq.queue references the target by its SQS *name* ("dead-queue"); nodes are
        // keyed by id, so metadata must carry the target's id ("dead") for the edge.
        { style: "function", file: "src/q.ts", exportName: "processOrder", source: "src/q.ts:1", id: "orders", name: "orders-queue", dlq: { queue: "dead-queue", maxReceiveCount: 3 } },
        { style: "function", file: "src/q.ts", exportName: "deadLetters", source: "src/q.ts:2", id: "dead", name: "dead-queue" },
      ],
    });
    const res = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [], priorPhysicalIds: new Set(), priorNodeLambdas: [] });
    const orders = res.find((r) => r.name === "orders")!;
    const dead = res.find((r) => r.name === "dead")!;
    expect(orders.metadata.dlq).toEqual({ queue: "dead", maxReceiveCount: 3 });
    // A queue without a DLQ carries no dlq key.
    expect(dead.metadata.dlq).toBeUndefined();
  });

  it("stores the structured schedule plus a ready-to-display description on cron metadata", () => {
    const ir = makeIr({
      http: undefined,
      crons: [
        { style: "function", file: "src/jobs.ts", exportName: "sweep", source: "src/jobs.ts:1", id: "sweep", schedule: { kind: "cron", expression: "* * * * ? *", dialect: "aws" } },
      ],
    });
    const [cron] = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [], priorPhysicalIds: new Set(), priorNodeLambdas: [] });
    // The FE reads `description` directly; the structured schedule is kept alongside it.
    expect(cron.metadata).toEqual({
      schedule: { kind: "cron", expression: "* * * * ? *", dialect: "aws", description: "Every minute" },
    });
  });

  it("surfaces missing env keys as per-resource metadata.warnings", () => {
    const ir = makeIr();
    const [http] = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: ["STRIPE_KEY", "DB_URL"], priorPhysicalIds: new Set(), priorNodeLambdas: [] });
    expect(http.metadata.warnings).toEqual(["STRIPE_KEY", "DB_URL"]);
    expect(http.externalUrl).toBeNull();
  });

  it("labels resources UPDATED when their pinned physical id already exists, CREATED otherwise", () => {
    const ir = makeIr({
      crons: [
        { style: "function", file: "src/jobs.ts", exportName: "cleanup", source: "src/jobs.ts:1", id: "cleanup", schedule: { kind: "rate", value: 1, unit: "day" } },
      ],
    });
    // http's Lambda (myapp-app-dev) is already in the stack; the cron (myapp-cleanup-dev) is new.
    const priorPhysicalIds = new Set(["myapp-app-dev"]);
    const res = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [], priorPhysicalIds, priorNodeLambdas: [] });

    expect(res.find((r) => r.type === "http")!.action).toBe("UPDATED");
    expect(res.find((r) => r.type === "cron")!.action).toBe("CREATED");
  });

  it("labels everything CREATED on a first deploy (no prior stack resources)", () => {
    const ir = makeIr();
    const [http] = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [], priorPhysicalIds: new Set(), priorNodeLambdas: [] });
    expect(http.action).toBe("CREATED");
  });

  it("reports a REMOVED row for a prior node Lambda the current IR no longer produces", () => {
    // Prior stack had http + a "cleanup" cron; the new IR keeps only http.
    const ir = makeIr();
    const priorPhysicalIds = new Set(["myapp-app-dev", "myapp-cleanup-dev"]);
    const priorNodeLambdas = [
      { logicalId: "HttpFn8A9B0C1D", functionName: "myapp-app-dev" },
      { logicalId: "CroncleanupFn2E3F4A5B", functionName: "myapp-cleanup-dev" },
    ];
    const res = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [], priorPhysicalIds, priorNodeLambdas });

    const removed = res.filter((r) => r.action === "REMOVED");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      name: "cleanup",
      type: "cron",
      action: "REMOVED",
      externalId: "arn:aws:lambda:eu-west-1:123456789012:function:myapp-cleanup-dev",
    });
    // http still exists this deploy → UPDATED, not REMOVED.
    expect(res.find((r) => r.type === "http")!.action).toBe("UPDATED");
  });

  it("does not report REMOVED for a CDK-internal helper Lambda (not a laranja node)", () => {
    // getStackSnapshot only surfaces laranja node Lambdas, so a helper never reaches
    // here — but even if one did, an unknown-prefix logical id maps to a plain
    // function. Passing only the still-present http Lambda yields zero REMOVED rows.
    const ir = makeIr();
    const res = buildDeployedResources({
      ir,
      region,
      account,
      outputs: {},
      missingEnv: [],
      priorPhysicalIds: new Set(["myapp-app-dev"]),
      priorNodeLambdas: [{ logicalId: "HttpFn8A9B0C1D", functionName: "myapp-app-dev" }],
    });
    expect(res.some((r) => r.action === "REMOVED")).toBe(false);
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
    const res = buildDeployedResources({ ir, region, account, outputs: {}, missingEnv: [], priorPhysicalIds: new Set(), priorNodeLambdas: [] });
    expect(res.map((r) => r.name)).toEqual(["http", "cleanup", "orders"]);
  });
});
