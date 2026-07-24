import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { queueUrlEnvName } from "@alzulejos/laranja-core";

// Mock the AWS SDK: capture the SendMessageCommand input and drive the client's
// send() from a spy, so these tests never touch AWS. `vi.hoisted` lets the mock
// factory (which is hoisted above imports) reference the shared spies.
const { sendSpy, commandSpy, azureSendSpy, getQueueClientSpy } = vi.hoisted(() => ({
  sendSpy: vi.fn(),
  // Regular functions (not arrows): both are invoked with `new`, and an arrow
  // function throws "is not a constructor".
  commandSpy: vi.fn(function (input: unknown) {
    return { input };
  }),
  azureSendSpy: vi.fn(),
  getQueueClientSpy: vi.fn(),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn(function () {
    return { send: sendSpy };
  }),
  SendMessageCommand: commandSpy,
}));

// Mock the Azure SDKs the same way, so the provider="azure" branch never touches
// Azure either. The QueueServiceClient exposes getQueueClient(name) → { sendMessage }.
vi.mock("@azure/storage-queue", () => ({
  QueueServiceClient: vi.fn(function () {
    return {
      getQueueClient: (name: string) => {
        getQueueClientSpy(name);
        return { sendMessage: azureSendSpy };
      },
    };
  }),
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(function () {
    return { kind: "managed-identity" };
  }),
}));

// Imported after the mock is registered (getQueue reaches the mocked SDK).
const { getQueue } = await import("@alzulejos/laranja-decorators");

const STD = queueUrlEnvName("emails");
const FIFO = queueUrlEnvName("orders.fifo");

/** The `SendMessageCommand` input from the Nth send() call. */
function sentInput(call = 0): Record<string, unknown> {
  return (sendSpy.mock.calls[call][0] as { input: Record<string, unknown> }).input;
}

describe("getQueue().send()", () => {
  beforeEach(() => {
    delete process.env.LARANJA_PROVIDER; // default provider is AWS
    sendSpy.mockReset().mockResolvedValue({ MessageId: "m-1" });
    commandSpy.mockClear();
    process.env[STD] = "https://sqs.eu-west-1.amazonaws.com/123456789012/emails";
    process.env[FIFO] = "https://sqs.eu-west-1.amazonaws.com/123456789012/orders.fifo";
  });

  afterEach(() => {
    delete process.env[STD];
    delete process.env[FIFO];
  });

  test("resolves the URL from env, JSON-serializes an object body, returns the messageId", async () => {
    const out = await getQueue("emails").send({ to: "a@b.co", subject: "hi" });
    const input = sentInput();
    expect(input.QueueUrl).toBe(process.env[STD]);
    expect(input.MessageBody).toBe(JSON.stringify({ to: "a@b.co", subject: "hi" }));
    expect(out).toEqual({ messageId: "m-1" });
  });

  test("sends a string payload as-is (no JSON wrapping)", async () => {
    await getQueue("emails").send("raw-body");
    expect(sentInput().MessageBody).toBe("raw-body");
  });

  test("throws for an undeclared queue (no target in env)", async () => {
    delete process.env[STD];
    expect(() => getQueue("emails")).toThrow(/no queue target in env/);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test("exposes the resolved URL on the handle", () => {
    expect(getQueue("emails").url).toBe(process.env[STD]);
  });

  test("passes delaySeconds on a standard queue", async () => {
    await getQueue("emails").send({ x: 1 }, { delaySeconds: 30 });
    const input = sentInput();
    expect(input.DelaySeconds).toBe(30);
    expect(input.MessageGroupId).toBeUndefined();
  });

  describe("FIFO", () => {
    test("requires a groupId — send throws without one, and never calls SQS", async () => {
      await expect(getQueue("orders.fifo").send({ id: 1 })).rejects.toThrow(/FIFO queue requires a groupId/);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    test("maps groupId/dedupId to the SQS fields and ignores delaySeconds", async () => {
      await getQueue("orders.fifo").send({ id: 1 }, { groupId: "cust-9", dedupId: "d-1", delaySeconds: 30 });
      const input = sentInput();
      expect(input.MessageGroupId).toBe("cust-9");
      expect(input.MessageDeduplicationId).toBe("d-1");
      expect(input.DelaySeconds).toBeUndefined();
    });
  });
});

describe("getQueue().send() on Azure", () => {
  // On Azure the env target is the PHYSICAL queue name, not a URL, and the queue
  // service endpoint comes from the identity-based AzureWebJobsStorage settings.
  const URI = "AzureWebJobsStorage__queueServiceUri";

  beforeEach(() => {
    process.env.LARANJA_PROVIDER = "azure";
    process.env[STD] = "emails"; // physical Storage Queue name
    process.env[URI] = "https://acct.queue.core.windows.net";
    azureSendSpy.mockReset().mockResolvedValue({ messageId: "az-1" });
    getQueueClientSpy.mockClear();
    sendSpy.mockReset(); // prove SQS is never touched on this path
  });

  afterEach(() => {
    delete process.env.LARANJA_PROVIDER;
    delete process.env[STD];
    delete process.env[URI];
  });

  test("enqueues to the Storage Queue named by the env target, returns the messageId", async () => {
    const out = await getQueue("emails").send({ hi: 1 });
    expect(getQueueClientSpy).toHaveBeenCalledWith("emails");
    expect(azureSendSpy).toHaveBeenCalledWith(JSON.stringify({ hi: 1 }), { visibilityTimeout: undefined });
    expect(out).toEqual({ messageId: "az-1" });
    expect(sendSpy).not.toHaveBeenCalled(); // never reaches SQS
  });

  test("sends a string as-is and maps delaySeconds to the message visibilityTimeout", async () => {
    await getQueue("emails").send("raw-body", { delaySeconds: 45 });
    expect(azureSendSpy).toHaveBeenCalledWith("raw-body", { visibilityTimeout: 45 });
  });

  test("throws when the queue service endpoint isn't in env", async () => {
    delete process.env[URI];
    await expect(getQueue("emails").send({ x: 1 })).rejects.toThrow(/AzureWebJobsStorage__queueServiceUri/);
    expect(azureSendSpy).not.toHaveBeenCalled();
  });
});
