import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { queueUrlEnvName } from "@alzulejos/laranja-core";

/**
 * Per-message options for `getQueue(name).send()`. FIFO queues REQUIRE `groupId`
 * (SQS rejects a FIFO send without a MessageGroupId); `dedupId` is only needed
 * when the queue doesn't use content-based deduplication. `delaySeconds` is
 * ignored by FIFO queues (SQS limitation), so it's a standard-queue knob.
 */
export interface SendOptions {
  /** MessageGroupId — required for FIFO queues, ignored for standard. */
  groupId?: string;
  /** MessageDeduplicationId — FIFO only, when content-based dedup is off. */
  dedupId?: string;
  /** Delay before the message becomes visible (0–900s). Standard queues only. */
  delaySeconds?: number;
}

/** A minimal producer handle for one declared queue. Returned by `getQueue()`. */
export interface LaranjaQueue {
  /** The resolved SQS URL this handle sends to. */
  readonly url: string;
  /** Enqueue a message. Objects are JSON-serialized; strings are sent as-is. */
  send(payload: unknown, options?: SendOptions): Promise<{ messageId?: string }>;
}

// One SQS client for the whole Lambda invocation environment — created lazily so
// importing this module has no cost for functions that never produce, and reused
// across warm invocations. Region comes from the Lambda's AWS_REGION env.
let client: SQSClient | undefined;
function sqs(): SQSClient {
  return (client ??= new SQSClient({}));
}

/**
 * Producer counterpart to the `@Queue` / `queue()` consumer: get a handle to a
 * declared queue and `.send()` messages to it. laranja provisions the wire — the
 * SQS URL is injected into every function's env at deploy and `sqs:SendMessage`
 * is granted — so this is pure infra glue, not a job framework: it resolves the
 * URL and makes one `SendMessage` call, nothing more.
 *
 * @param name The queue's declared `name` (as in `queue({ name })`).
 * @example
 *   await getQueue("emails").send({ to, subject });
 *   await getQueue("orders.fifo").send(order, { groupId: order.customerId });
 */
export function getQueue(name: string): LaranjaQueue {
  const url = process.env[queueUrlEnvName(name)];
  if (!url) {
    throw new Error(
      `getQueue("${name}"): no queue URL in env. Is "${name}" a declared queue in this project?`,
    );
  }
  const isFifo = url.endsWith(".fifo");

  return {
    url,
    async send(payload, options = {}) {
      if (isFifo && !options.groupId) {
        throw new Error(`getQueue("${name}").send: FIFO queue requires a groupId.`);
      }
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      const out = await sqs().send(
        new SendMessageCommand({
          QueueUrl: url,
          MessageBody: body,
          MessageGroupId: isFifo ? options.groupId : undefined,
          MessageDeduplicationId: isFifo ? options.dedupId : undefined,
          DelaySeconds: !isFifo ? options.delaySeconds : undefined,
        }),
      );
      return { messageId: out.MessageId };
    },
  };
}
