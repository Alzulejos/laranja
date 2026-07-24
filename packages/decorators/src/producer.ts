import { queueUrlEnvName, PROVIDER_ENV_NAME } from "@alzulejos/laranja-core";

/**
 * Per-message options for `getQueue(name).send()`.
 *
 * `groupId`/`dedupId` are FIFO knobs — FIFO exists only on AWS SQS (the scanner
 * rejects FIFO queues on Azure), so they're ignored on the Azure path. `delaySeconds`
 * maps to SQS `DelaySeconds` on AWS and to a Storage Queue message's initial
 * `visibilityTimeout` on Azure — the same "become visible later" behaviour.
 */
export interface SendOptions {
  /** MessageGroupId — required for FIFO queues (AWS), ignored elsewhere. */
  groupId?: string;
  /** MessageDeduplicationId — FIFO only, when content-based dedup is off. */
  dedupId?: string;
  /** Delay before the message becomes visible (0–900s). */
  delaySeconds?: number;
}

/** A minimal producer handle for one declared queue. Returned by `getQueue()`. */
export interface LaranjaQueue {
  /**
   * The resolved target this handle sends to — an SQS URL on AWS, the physical
   * Storage Queue name on Azure. It's the raw value the back-half injected under
   * `queueUrlEnvName(name)`; kept on the handle for logging/inspection.
   */
  readonly url: string;
  /** Enqueue a message. Objects are JSON-serialized; strings are sent as-is. */
  send(payload: unknown, options?: SendOptions): Promise<{ messageId?: string }>;
}

// Clients are created lazily and reused across warm invocations. Importing this
// module has NO cost — and no SDK is loaded — for a function that never produces;
// the provider's SDK is pulled by a dynamic import only on the first `.send()`.
type SqsClient = import("@aws-sdk/client-sqs").SQSClient;
type QueueServiceClient = import("@azure/storage-queue").QueueServiceClient;
let sqsClient: SqsClient | undefined;
let azureQueueService: QueueServiceClient | undefined;

/**
 * Producer counterpart to the `@Queue` / `queue()` consumer: get a handle to a
 * declared queue and `.send()` messages to it. laranja provisions the wire — the
 * target (SQS URL on AWS, queue name on Azure) is injected into every function's
 * env at deploy and send permission is granted — so this is pure infra glue, not
 * a job framework: it resolves the target and makes one enqueue call, nothing more.
 *
 * The cloud is read from `PROVIDER_ENV_NAME` (set by the back-half; absent ⇒ AWS),
 * NOT sniffed from the target's shape — so the same `getQueue().send()` works on
 * either provider without the caller knowing or caring which.
 *
 * @param name The queue's declared `name` (as in `queue({ name })`).
 * @example
 *   await getQueue("emails").send({ to, subject });
 *   await getQueue("orders.fifo").send(order, { groupId: order.customerId }); // AWS FIFO
 */
export function getQueue(name: string): LaranjaQueue {
  const target = process.env[queueUrlEnvName(name)];
  if (!target) {
    throw new Error(
      `getQueue("${name}"): no queue target in env. Is "${name}" a declared queue in this project?`,
    );
  }
  const provider = process.env[PROVIDER_ENV_NAME] ?? "aws";

  return {
    url: target,
    send(payload, options = {}) {
      // JSON body shape is identical across providers (SQS MessageBody and a Storage
      // Queue message are both opaque text), so the consumer sees the same string
      // regardless of where it ran — the one contract the shim relies on.
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      return provider === "azure"
        ? sendAzure(name, target, body, options)
        : sendSqs(name, target, body, options);
    },
  };
}

/** AWS: one `SendMessage` to SQS. FIFO knobs apply; the ".fifo" suffix marks FIFO. */
async function sendSqs(
  name: string,
  url: string,
  body: string,
  options: SendOptions,
): Promise<{ messageId?: string }> {
  const isFifo = url.endsWith(".fifo");
  if (isFifo && !options.groupId) {
    throw new Error(`getQueue("${name}").send: FIFO queue requires a groupId.`);
  }
  const { SQSClient, SendMessageCommand } = await import("@aws-sdk/client-sqs");
  sqsClient ??= new SQSClient({});
  const out = await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: isFifo ? options.groupId : undefined,
      MessageDeduplicationId: isFifo ? options.dedupId : undefined,
      DelaySeconds: !isFifo ? options.delaySeconds : undefined,
    }),
  );
  return { messageId: out.MessageId };
}

/**
 * Azure: enqueue to a Storage Queue.
 *
 * The queue service endpoint and the app's managed identity are already wired for
 * the Functions host under `AzureWebJobsStorage__*` (the back-half sets
 * `__queueServiceUri` + `__credential: managedidentity` and grants Storage Queue
 * Data Contributor), so the producer reuses exactly that identity — no connection
 * string or SAS. `groupId`/`dedupId` don't apply (Storage Queues have no FIFO);
 * `delaySeconds` becomes the message's initial `visibilityTimeout`.
 */
async function sendAzure(
  name: string,
  queueName: string,
  body: string,
  options: SendOptions,
): Promise<{ messageId?: string }> {
  const serviceUri = process.env.AzureWebJobsStorage__queueServiceUri;
  if (!serviceUri) {
    throw new Error(
      `getQueue("${name}").send: AzureWebJobsStorage__queueServiceUri is not set — ` +
        `is this running inside a laranja-deployed Azure Function App?`,
    );
  }
  const [{ QueueServiceClient }, { DefaultAzureCredential }] = await Promise.all([
    import("@azure/storage-queue"),
    import("@azure/identity"),
  ]);
  azureQueueService ??= new QueueServiceClient(serviceUri, new DefaultAzureCredential());
  const client = azureQueueService.getQueueClient(queueName);
  const out = await client.sendMessage(body, {
    visibilityTimeout: options.delaySeconds,
  });
  return { messageId: out.messageId };
}
