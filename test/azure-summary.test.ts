import { describe, test, expect, vi } from "vitest";
import type { InfraIR } from "../packages/core/src/ir.js";
import { buildAzureResources, printAzureFunctions } from "../packages/cli/src/azure-summary.js";

const target = { subscriptionId: "sub-123", resourceGroup: "rg-app" };

function makeIr(over: Partial<InfraIR> = {}): InfraIR {
  return {
    app: { name: "shop", framework: "express", provider: "azure", stage: "dev", entry: "src/app.ts" },
    http: { handlerEntry: "src/app.ts", appExport: "app", routes: [{ method: "GET", path: "/", source: "src/app.ts:1" }] },
    crons: [],
    queues: [],
    env: {},
    envKeys: [],
    ...over,
  };
}

const cron = (id: string, schedule: InfraIR["crons"][number]["schedule"]): InfraIR["crons"][number] => ({
  style: "function",
  file: "src/jobs.ts",
  exportName: id,
  source: "src/jobs.ts:1",
  id,
  schedule,
});

const queue = (name: string): InfraIR["queues"][number] => ({
  style: "function",
  file: "src/jobs.ts",
  exportName: name,
  source: "src/jobs.ts:1",
  id: name,
  name,
});

describe("azure reported resources", () => {
  test("with no crons, only the function app is reported", () => {
    const resources = buildAzureResources({
      name: "shop-dev",
      appName: "shop",
      stage: "dev",
      monitoring: false,
      target,
      crons: [],
      queues: [],
      missingEnv: [],
      action: "CREATED",
    });
    expect(resources).toHaveLength(1);
    expect(resources[0].type).toBe("http");
  });

  test("each cron is reported as its own resource with a readable schedule", () => {
    const crons = [
      cron("poll", { kind: "rate", value: 5, unit: "minute" }),
      cron("nightly", { kind: "cron", expression: "0 0 * * ? *", dialect: "aws" }),
    ];
    const resources = buildAzureResources({
      name: "shop-dev",
      appName: "shop",
      stage: "dev",
      monitoring: false,
      target,
      crons,
      queues: [],
      missingEnv: [],
      action: "UPDATED",
    });

    // http + one row per cron — so the dashboard shows the scheduled jobs.
    expect(resources.map((r) => `${r.type}:${r.name}`)).toEqual(["http:http", "cron:poll", "cron:nightly"]);

    const poll = resources.find((r) => r.name === "poll")!;
    expect(poll.type).toBe("cron");
    expect(poll.action).toBe("UPDATED"); // follows the app
    // A ready-to-display label rides along, like the AWS report.
    expect((poll.metadata.schedule as { description: string }).description).toBe("Every 5 minutes");
    // Each resource maps to its OWN function under the shared app.
    expect(poll.externalId).toBe(
      "/subscriptions/sub-123/resourceGroups/rg-app/providers/Microsoft.Web/sites/shop-dev/functions/poll",
    );
    // http maps to the `api` function, not the bare app.
    expect(resources[0].externalId).toBe(
      "/subscriptions/sub-123/resourceGroups/rg-app/providers/Microsoft.Web/sites/shop-dev/functions/api",
    );
  });

  test("each queue is reported as a queue resource mapping to its consumer function", () => {
    const resources = buildAzureResources({
      name: "shop-dev",
      appName: "shop",
      stage: "dev",
      monitoring: false,
      target,
      crons: [],
      queues: [queue("emails"), queue("sms")],
      missingEnv: [],
      action: "CREATED",
    });

    // http + one row per queue, so the dashboard's queue→function graph renders.
    expect(resources.map((r) => `${r.type}:${r.name}`)).toEqual(["http:http", "queue:emails", "queue:sms"]);

    const emails = resources.find((r) => r.name === "emails")!;
    // Storage Queues have no FIFO, and metadata carries the physical queue name.
    expect(emails.metadata).toEqual({ queueName: "emails", fifo: false });
    // The consumer function is registered under the queue NAME (see registerAzureQueue).
    expect(emails.externalId).toBe(
      "/subscriptions/sub-123/resourceGroups/rg-app/providers/Microsoft.Web/sites/shop-dev/functions/emails",
    );
    expect(emails.externalUrl).toBeNull();
  });

  test("missing env surfaces as a warning on the http resource only", () => {
    const resources = buildAzureResources({
      name: "shop-dev",
      appName: "shop",
      stage: "dev",
      monitoring: false,
      target,
      crons: [cron("poll", { kind: "rate", value: 1, unit: "hour" })],
      queues: [],
      missingEnv: ["DATABASE_URL"],
      action: "CREATED",
    });
    expect(resources[0].metadata.warnings).toEqual(["env with no value: DATABASE_URL"]);
    expect(resources[1].metadata.warnings).toBeUndefined();
  });

  test("monitoring on adds a dashboard row deep-linking to App Insights", () => {
    const resources = buildAzureResources({
      name: "shop-dev",
      appName: "shop",
      stage: "dev",
      monitoring: true,
      target,
      crons: [],
      queues: [],
      missingEnv: [],
      action: "CREATED",
    });
    // http + the observability node — the SAME `dashboard` type the AWS path emits.
    expect(resources.map((r) => `${r.type}:${r.name}`)).toEqual(["http:http", "dashboard:monitoring"]);
    const mon = resources.find((r) => r.name === "monitoring")!;
    const aiId =
      "/subscriptions/sub-123/resourceGroups/rg-app/providers/Microsoft.Insights/components/shop-dev-ai";
    expect(mon.externalId).toBe(aiId);
    expect(mon.externalUrl).toBe(`https://portal.azure.com/#@/resource${aiId}/overview`);
  });

  test("monitoring off emits no dashboard row", () => {
    const resources = buildAzureResources({
      name: "shop-dev",
      appName: "shop",
      stage: "dev",
      monitoring: false,
      target,
      crons: [],
      queues: [],
      missingEnv: [],
      action: "CREATED",
    });
    expect(resources.some((r) => r.type === "dashboard")).toBe(false);
  });
});

describe("azure functions summary", () => {
  test("prints each cron with its schedule so it isn't invisible", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printAzureFunctions(makeIr({ crons: [cron("poll", { kind: "rate", value: 5, unit: "minute" })] }));
      const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain("poll");
      expect(out).toContain("Every 5 minutes");
      expect(out).toContain("Cron");
    } finally {
      log.mockRestore();
    }
  });

  test("prints each queue so it isn't invisible", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printAzureFunctions(makeIr({ queues: [queue("emails")] }));
      const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain("emails");
      expect(out).toContain("Queue");
    } finally {
      log.mockRestore();
    }
  });
});
