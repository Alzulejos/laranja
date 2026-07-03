import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

type Ctor<T> = new () => T;

/** The signature an `@Queue` consumer method receives: parsed body + raw record. */
export type QueueConsumer = (body: unknown, record: SQSRecord, context: Context) => unknown | Promise<unknown>;

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Builds the Lambda handler for a `@Queue` method or `queue()` function. Calls the
 * consumer once per message with the JSON-parsed body. Failed messages are
 * reported back via the partial-batch-failure contract, so the CDK event source
 * must enable `reportBatchItemFailures`.
 *
 * - Function form (`createQueueHandler(fn)`): calls the function per message.
 * - Method form (`createQueueHandler(Ctor, "method")`): instantiates the class
 *   once (cached) and calls the decorated method.
 */
export function createQueueHandler(
  consumer: QueueConsumer,
): (event: SQSEvent, context: Context) => Promise<SQSBatchResponse>;
export function createQueueHandler<T extends object>(
  Ctor: Ctor<T>,
  method: keyof T & string,
): (event: SQSEvent, context: Context) => Promise<SQSBatchResponse>;
export function createQueueHandler<T extends object>(
  target: Ctor<T> | QueueConsumer,
  method?: keyof T & string,
): (event: SQSEvent, context: Context) => Promise<SQSBatchResponse> {
  let instance: T | undefined;
  const resolveConsumer = (): QueueConsumer => {
    if (method === undefined) return target as QueueConsumer;
    const Ctor = target as Ctor<T>;
    instance ??= new Ctor();
    const fn = instance[method] as unknown;
    if (typeof fn !== "function") {
      throw new Error(`@Queue target ${Ctor.name}.${String(method)} is not a method`);
    }
    return (fn as QueueConsumer).bind(instance);
  };

  return async (event, context) => {
    const consumer = resolveConsumer();
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        await consumer(parseBody(record.body), record, context);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
