import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

type Ctor<T> = new () => T;

/** The signature an `@Queue` consumer method receives: parsed body + raw record. */
export type QueueConsumer = (body: unknown, record: SQSRecord, context: Context) => unknown | Promise<unknown>;

/**
 * Parse a queue message body into what the consumer sees. On AWS the SQS body is
 * always a string; on Azure the Functions host may hand back an already-deserialized
 * object for JSON messages — so pass non-strings through untouched and only attempt
 * a parse on a string, falling back to the raw string when it isn't JSON. Either way
 * the consumer sees the same shape the producer sent.
 */
export function parseQueueBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Resolve a `@Queue` method or `queue()` function into a callable consumer, with a
 * once-per-process instance cache for the class form. Provider-neutral: both the
 * AWS batch handler and the Azure Storage-Queue registration build on this so the
 * function-vs-method dispatch lives in one place (mirrors `makeScheduledInvoker`).
 */
export function makeQueueConsumer(consumer: QueueConsumer): QueueConsumer;
export function makeQueueConsumer<T extends object>(Ctor: Ctor<T>, method: keyof T & string): QueueConsumer;
export function makeQueueConsumer<T extends object>(
  target: Ctor<T> | QueueConsumer,
  method?: keyof T & string,
): QueueConsumer {
  if (method === undefined) return target as QueueConsumer;
  const Ctor = target as Ctor<T>;
  let instance: T | undefined;
  return (body, record, context) => {
    instance ??= new Ctor();
    const fn = instance[method] as unknown;
    if (typeof fn !== "function") {
      throw new Error(`@Queue target ${Ctor.name}.${String(method)} is not a method`);
    }
    return (fn as QueueConsumer).call(instance, body, record, context);
  };
}

/**
 * Drive an SQS batch through a consumer, one message at a time, collecting the
 * IDs that threw into the partial-batch-failure response. Shared by the plain and
 * the Nest/DI-backed consumer handlers so the retry contract lives in one place.
 */
export async function runSqsBatch(
  consumer: QueueConsumer,
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await consumer(parseQueueBody(record.body), record, context);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
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
  // Overloads guarantee the arg pairing; the cast just picks the right signature.
  const consumer =
    method === undefined
      ? makeQueueConsumer(target as QueueConsumer)
      : makeQueueConsumer(target as Ctor<T>, method);
  return async (event, context) => runSqsBatch(consumer, event, context);
}
