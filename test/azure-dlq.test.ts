import { describe, test, expect } from "vitest";
import {
  azureMaxDequeueCount,
  azurePoisonBindings,
  azurePoisonQueueEnvName,
  buildAzureHostJson,
} from "@alzulejos/laranja-core";

const q = (name: string, dlq?: { queue: string; maxReceiveCount: number }) => ({ name, dlq });

describe("azurePoisonBindings", () => {
  test("one source → one DLQ is wired", () => {
    const { bindings, conflicts } = azurePoisonBindings([
      q("mails", { queue: "mailsDLQ", maxReceiveCount: 1 }),
      q("mailsDLQ"),
    ]);
    // Azure moves mails' failures to "mails-poison"; that's what the DLQ consumer binds.
    expect(bindings).toEqual([{ source: "mails", dlq: "mailsDLQ" }]);
    expect(conflicts).toEqual([]);
  });

  test("two sources sharing one DLQ are NOT wired, they're reported", () => {
    const { bindings, conflicts } = azurePoisonBindings([
      q("a", { queue: "shared", maxReceiveCount: 3 }),
      q("b", { queue: "shared", maxReceiveCount: 3 }),
      q("shared"),
    ]);
    // Half-wiring would silently deliver one source's failures and drop the other's.
    expect(bindings).toEqual([]);
    expect(conflicts).toEqual([{ dlq: "shared", sources: ["a", "b"] }]);
  });

  test("independent DLQs are each wired", () => {
    const { bindings, conflicts } = azurePoisonBindings([
      q("a", { queue: "aDLQ", maxReceiveCount: 1 }),
      q("b", { queue: "bDLQ", maxReceiveCount: 1 }),
      q("aDLQ"),
      q("bDLQ"),
    ]);
    expect(bindings).toEqual([
      { source: "a", dlq: "aDLQ" },
      { source: "b", dlq: "bDLQ" },
    ]);
    expect(conflicts).toEqual([]);
  });

  test("no dlq declarations means nothing to wire", () => {
    expect(azurePoisonBindings([q("mails"), q("sms")])).toEqual({ bindings: [], conflicts: [] });
  });

  test("a target that isn't a declared queue is skipped, not bound to a phantom", () => {
    const { bindings } = azurePoisonBindings([q("mails", { queue: "nope", maxReceiveCount: 1 })]);
    expect(bindings).toEqual([]);
  });

  test("a self-referential target is skipped", () => {
    const { bindings } = azurePoisonBindings([q("mails", { queue: "mails", maxReceiveCount: 1 })]);
    expect(bindings).toEqual([]);
  });
});

describe("azurePoisonQueueEnvName", () => {
  test("is distinct from the source queue's own name setting", () => {
    expect(azurePoisonQueueEnvName("mails")).toBe("LARANJA_QUEUE_mails_POISON");
    // Non-alphanumerics fold to underscores, like the other setting keys.
    expect(azurePoisonQueueEnvName("order-events")).toBe("LARANJA_QUEUE_order_events_POISON");
  });
});

describe("azureMaxDequeueCount", () => {
  test("takes the declared value for the app", () => {
    expect(azureMaxDequeueCount([q("mails", { queue: "d", maxReceiveCount: 3 }), q("d")])).toEqual({
      value: 3,
      conflicting: [],
    });
  });

  test("reports queues in the SAME app that disagree", () => {
    const out = azureMaxDequeueCount([
      q("a", { queue: "d", maxReceiveCount: 3 }),
      q("b", { queue: "d2", maxReceiveCount: 7 }),
    ]);
    // Host-wide on Azure: one value wins, and the other must be surfaced not swallowed.
    expect(out).toEqual({ value: 3, conflicting: ["b"] });
  });

  test("no declarations leaves the host default", () => {
    expect(azureMaxDequeueCount([q("mails")])).toEqual({ value: undefined, conflicting: [] });
  });
});

describe("buildAzureHostJson", () => {
  test("omits the queues extension when no maxReceiveCount is declared", () => {
    const host = buildAzureHostJson(30) as { extensions: Record<string, unknown> };
    expect(host.extensions.queues).toBeUndefined();
  });

  test("carries maxDequeueCount when declared, keeping the http route prefix", () => {
    const host = buildAzureHostJson(45, 3) as {
      functionTimeout: string;
      extensions: { queues: { maxDequeueCount: number }; http: { routePrefix: string } };
    };
    expect(host.functionTimeout).toBe("00:00:45");
    expect(host.extensions.queues).toEqual({ maxDequeueCount: 3 });
    expect(host.extensions.http.routePrefix).toBe("");
  });
});
