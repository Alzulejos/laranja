import { randomUUID } from "node:crypto";
import {
  queueUrlEnvName,
  PROVIDER_ENV_NAME,
  LOCAL_PROVIDER,
  LOCAL_QUEUE_URL_ENV,
  localDelayedKey,
  localQueueKey,
  type LocalQueueMessage,
} from "@alzulejos/laranja-core";

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
  const provider = process.env[PROVIDER_ENV_NAME] ?? "aws";
  // Locally the "target" is a Redis key we derive from the name, so `laranja dev`
  // doesn't have to fabricate a URL per queue just to satisfy this lookup.
  const target =
    process.env[queueUrlEnvName(name)] ??
    (provider === LOCAL_PROVIDER ? localQueueKey(name) : undefined);
  if (!target) {
    throw new Error(
      `getQueue("${name}"): no queue target in env. Is "${name}" a declared queue in this project?`,
    );
  }

  return {
    url: target,
    send(payload, options = {}) {
      // JSON body shape is identical across providers (SQS MessageBody and a Storage
      // Queue message are both opaque text), so the consumer sees the same string
      // regardless of where it ran — the one contract the shim relies on.
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      if (provider === LOCAL_PROVIDER) return sendLocal(name, body, options);
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
  // BASE64: the Azure Functions Storage Queue TRIGGER decodes messages as base64 by
  // default (its `QueueMessageEncoding` default), but `@azure/storage-queue` sends
  // text as-is. A raw-JSON message therefore fails to decode at the binding layer —
  // the host retries and dead-letters to `<queue>-poison` WITHOUT ever invoking the
  // consumer (no function execution, no handler error). Encoding here makes the
  // producer match the trigger, so the consumer receives the original body decoded.
  const out = await client.sendMessage(Buffer.from(body, "utf8").toString("base64"), {
    visibilityTimeout: options.delaySeconds,
  });
  return { messageId: out.messageId };
}

/**
 * Local (`laranja dev`): enqueue into the Redis backing the project's queues.
 *
 * `delaySeconds` becomes a score in the delayed sorted set rather than a sleep,
 * so a delayed message survives the producer exiting — the same guarantee SQS
 * gives, and the reason this isn't an in-process queue.
 */
async function sendLocal(
  name: string,
  body: string,
  options: SendOptions,
): Promise<{ messageId?: string }> {
  const url = process.env[LOCAL_QUEUE_URL_ENV];
  if (!url) {
    throw new Error(
      `getQueue("${name}").send: ${LOCAL_QUEUE_URL_ENV} is not set — run \`laranja dev\` and load .laranja/dev.env.`,
    );
  }
  const client = await localClient(url);
  const message: LocalQueueMessage = {
    id: randomUUID(),
    body,
    receiveCount: 0,
    enqueuedAt: Date.now(),
  };
  const payload = JSON.stringify(message);

  if (options.delaySeconds && options.delaySeconds > 0) {
    await client.zadd(localDelayedKey(name), Date.now() + options.delaySeconds * 1000, payload);
  } else {
    // LPUSH + the poller's RPOP gives FIFO order for a single consumer. Real SQS
    // standard queues don't promise ordering, so nothing may depend on it — but
    // getting it for free makes local runs reproducible.
    await client.lpush(localQueueKey(name), payload);
  }
  return { messageId: message.id };
}

type RedisClient = import("ioredis").Redis;
let redisClient: RedisClient | undefined;

/** Lazily open one Redis connection, reused for every subsequent send. */
async function localClient(url: string): Promise<RedisClient> {
  if (redisClient) return redisClient;
  let Redis: typeof import("ioredis").Redis;
  try {
    ({ Redis } = await import("ioredis"));
  } catch {
    throw new Error(
      "Local queues need `ioredis`. Install it in your project: npm i -D ioredis",
    );
  }
  redisClient = new Redis(url, { maxRetriesPerRequest: null });
  return redisClient;
}
