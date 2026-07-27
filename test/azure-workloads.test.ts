import { describe, test, expect } from "vitest";
import { azureWorkloads, azureFunctionAppName, azurePlanName } from "@alzulejos/laranja-core";

/** The slice of the IR the grouping reads. */
const ir = (over: Partial<Parameters<typeof azureWorkloads>[0]> = {}) => ({
  crons: [],
  queues: [],
  ...over,
});

const cron = (id: string, workersId?: string) => ({ id, workersId });
const queue = (name: string, workersId?: string) => ({ name, workersId });

describe("azureWorkloads", () => {
  test("an http app with no roots stays ONE app, named as it always was", () => {
    const w = azureWorkloads(ir({ http: {}, crons: [cron("poll")], queues: [queue("emails")] }));
    expect(w).toEqual([
      { id: "http", http: true, cronIds: ["poll"], queueNames: ["emails"] },
    ]);
    // No suffix => the historical name. Renaming would destroy and recreate the app.
    expect(azureFunctionAppName("shop", "dev", w[0].suffix)).toBe("shop-dev");
  });

  test("each workers() root becomes its own app, so its compute can apply", () => {
    const w = azureWorkloads(
      ir({
        http: {},
        workers: [{ id: "CronModule" }, { id: "BillingModule" }],
        crons: [cron("poll"), cron("Tasks-sweep", "CronModule")],
        queues: [queue("invoices", "BillingModule")],
      }),
    );
    expect(w.map((x) => x.id)).toEqual(["http", "CronModule", "BillingModule"]);
    // The DI-bound handlers leave the primary workload entirely.
    expect(w[0]).toEqual({ id: "http", http: true, cronIds: ["poll"], queueNames: [] });
    expect(w[1]).toEqual({
      id: "CronModule", suffix: "CronModule", workersId: "CronModule",
      http: false, cronIds: ["Tasks-sweep"], queueNames: [],
    });
    expect(w[2].queueNames).toEqual(["invoices"]);
    // Distinct app + plan names per workload.
    expect(azureFunctionAppName("shop", "dev", w[1].suffix)).toBe("shop-dev-cronmodule");
    expect(azurePlanName("shop", "dev", w[1].suffix)).toBe("shop-dev-cronmodule-plan");
  });

  test("no primary workload when every handler belongs to a root", () => {
    // A Nest workers-only project: nothing for the primary app to host, so don't
    // deploy an empty one.
    const w = azureWorkloads(
      ir({ workers: [{ id: "CronModule" }], crons: [cron("Tasks-sweep", "CronModule")] }),
    );
    expect(w.map((x) => x.id)).toEqual(["CronModule"]);
  });

  test("a crons-only app keeps the primary workload (and its id) with no http", () => {
    const w = azureWorkloads(ir({ crons: [cron("poll")] }));
    expect(w).toEqual([{ id: "http", http: false, cronIds: ["poll"], queueNames: [] }]);
  });

  test("a root with no handlers bound to it deploys nothing", () => {
    const w = azureWorkloads(ir({ http: {}, workers: [{ id: "Unused" }] }));
    expect(w.map((x) => x.id)).toEqual(["http"]);
  });

  test("a handler naming a root that doesn't exist stays in the primary app", () => {
    // Belt-and-braces: a dangling workersId must not make the handler vanish from
    // every workload and be silently undeployed.
    const w = azureWorkloads(ir({ http: {}, crons: [cron("orphan", "GoneModule")] }));
    expect(w).toEqual([{ id: "http", http: true, cronIds: ["orphan"], queueNames: [] }]);
  });

  test("an empty project produces no workloads", () => {
    expect(azureWorkloads(ir())).toEqual([]);
  });
});
