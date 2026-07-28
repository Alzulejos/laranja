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

/**
 * `buildAzureResources` args for the common single-app shape. `apps` maps workload id
 * to Function App name — one entry unless the project declares `workers()` roots.
 */
function build(over: {
  crons?: InfraIR["crons"];
  queues?: InfraIR["queues"];
  workers?: InfraIR["workers"];
  hasHttp?: boolean;
  monitoring?: boolean;
  missingEnv?: string[];
  action?: "CREATED" | "UPDATED";
  apps?: Record<string, string>;
}) {
  const hasHttp = over.hasHttp ?? true;
  const ir = makeIr({
    ...(hasHttp ? {} : { http: undefined }),
    crons: over.crons ?? [],
    queues: over.queues ?? [],
    ...(over.workers ? { workers: over.workers } : {}),
  });
  return buildAzureResources({
    name: "shop-dev",
    appName: "shop",
    stage: "dev",
    monitoring: over.monitoring ?? false,
    hasHttp,
    target,
    ir,
    apps: over.apps ?? { http: "shop-dev" },
    missingEnv: over.missingEnv ?? [],
    action: over.action ?? "CREATED",
  });
}

describe("azure reported resources", () => {
  test("with no crons, only the function app is reported", () => {
    const resources = build({});
    expect(resources).toHaveLength(1);
    expect(resources[0].type).toBe("http");
  });

  test("each cron is reported as its own resource with a readable schedule", () => {
    const resources = build({
      action: "UPDATED",
      crons: [
        cron("poll", { kind: "rate", value: 5, unit: "minute" }),
        cron("nightly", { kind: "cron", expression: "0 0 * * ? *", dialect: "aws" }),
      ],
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
    const resources = build({ queues: [queue("emails"), queue("sms")] });

    // http + one row per queue, so the dashboard's queue→function graph renders.
    expect(resources.map((r) => `${r.type}:${r.name}`)).toEqual(["http:http", "queue:emails", "queue:sms"]);

    const emails = resources.find((r) => r.name === "emails")!;
    // Storage Queues have no FIFO, and metadata carries the physical queue name plus
    // the app hosting the consumer (what lets the dashboard group rows by app).
    expect(emails.metadata).toEqual({ queueName: "emails", fifo: false, functionApp: "shop-dev" });
    // The consumer function is registered under the queue NAME (see registerAzureQueue).
    expect(emails.externalId).toBe(
      "/subscriptions/sub-123/resourceGroups/rg-app/providers/Microsoft.Web/sites/shop-dev/functions/emails",
    );
    expect(emails.externalUrl).toBeNull();
  });

  test("a wired dlq is reported like AWS's, plus the poison queue it flows through", () => {
    const resources = build({
      queues: [{ ...queue("emails"), dlq: { queue: "failed", maxReceiveCount: 3 } }, queue("failed")],
    });

    const emails = resources.find((r) => r.name === "emails")!;
    expect(emails.metadata.dlq).toEqual({
      // The TARGET's resource id, so the dashboard draws the edge between two nodes.
      queue: "failed",
      maxReceiveCount: 3,
      // Azure-only: where the host actually puts failures before laranja drains them.
      poisonQueue: "emails-poison",
    });
    // The DLQ queue is an ordinary queue in its own right — no dlq of its own.
    expect(resources.find((r) => r.name === "failed")!.metadata.dlq).toBeUndefined();
  });

  test("a dlq shared by two queues is reported as unwired, naming the unread poison queues", () => {
    const resources = build({
      queues: [
        { ...queue("emails"), dlq: { queue: "failed", maxReceiveCount: 3 } },
        { ...queue("sms"), dlq: { queue: "failed", maxReceiveCount: 3 } },
        queue("failed"),
      ],
    });

    for (const name of ["emails", "sms"]) {
      const res = resources.find((r) => r.name === name)!;
      // No redrive edge — the synth leaves these unwired, so claiming one would lie.
      expect(res.metadata.dlq).toBeUndefined();
      expect(res.metadata.warnings?.[0]).toContain(`"${name}-poison"`);
    }
  });

  test("missing env surfaces as a warning on the http resource only", () => {
    const resources = build({
      crons: [cron("poll", { kind: "rate", value: 1, unit: "hour" })],
      missingEnv: ["DATABASE_URL"],
    });
    expect(resources[0].metadata.warnings).toEqual(["env with no value: DATABASE_URL"]);
    expect(resources[1].metadata.warnings).toBeUndefined();
  });

  test("monitoring on adds a dashboard row deep-linking to App Insights", () => {
    const resources = build({ monitoring: true });
    // http + the observability node — the SAME `dashboard` type the AWS path emits.
    expect(resources.map((r) => `${r.type}:${r.name}`)).toEqual(["http:http", "dashboard:monitoring"]);
    const mon = resources.find((r) => r.name === "monitoring")!;
    const aiId =
      "/subscriptions/sub-123/resourceGroups/rg-app/providers/Microsoft.Insights/components/shop-dev-ai";
    expect(mon.externalId).toBe(aiId);
    expect(mon.externalUrl).toBe(`https://portal.azure.com/#@/resource${aiId}/overview`);
  });

  test("a crons/queues-only app (no http) reports no http row", () => {
    const resources = build({
      hasHttp: false,
      crons: [cron("poll", { kind: "rate", value: 5, unit: "minute" })],
      queues: [queue("emails")],
      missingEnv: ["DATABASE_URL"],
    });
    // No http row — just the cron + queue functions.
    expect(resources.map((r) => `${r.type}:${r.name}`)).toEqual(["cron:poll", "queue:emails"]);
    // The app-level missing-env warning still surfaces — on the first function.
    expect(resources[0].metadata.warnings).toEqual(["env with no value: DATABASE_URL"]);
  });

  test("monitoring off emits no dashboard row", () => {
    expect(build({}).some((r) => r.type === "dashboard")).toBe(false);
  });

  test("a workers() root's functions link to ITS app, not the primary one", () => {
    // The bug this guards: hanging every function off the primary app produced portal
    // links to functions that don't exist there.
    const resources = build({
      workers: [{ id: "CronModule", handlerEntry: "src/cron.module.ts", appExport: "default" }],
      crons: [
        { ...cron("poll", { kind: "rate", value: 5, unit: "minute" }), style: "method", className: "Jobs", method: "poll", workersId: "CronModule" } as InfraIR["crons"][number],
      ],
      queues: [{ ...queue("emails"), style: "method", className: "Mailer", method: "send", workersId: "CronModule" } as InfraIR["queues"][number]],
      apps: { http: "shop-dev", CronModule: "shop-dev-cronmodule" },
    });

    const base = "/subscriptions/sub-123/resourceGroups/rg-app/providers/Microsoft.Web/sites";
    // http stays on the primary app…
    expect(resources.find((r) => r.type === "http")!.externalId).toBe(`${base}/shop-dev/functions/api`);
    // …while the DI-bound cron and queue address the worker app that runs them.
    expect(resources.find((r) => r.name === "poll")!.externalId).toBe(
      `${base}/shop-dev-cronmodule/functions/poll`,
    );
    expect(resources.find((r) => r.name === "emails")!.externalId).toBe(
      `${base}/shop-dev-cronmodule/functions/emails`,
    );
    // Every row names its host, so the dashboard can group by app.
    expect(resources.find((r) => r.name === "poll")!.metadata.functionApp).toBe("shop-dev-cronmodule");
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
