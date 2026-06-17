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
 * Builds the Lambda handler for an `@Queue` consumer. Calls the method once per
 * message with the JSON-parsed body. Failed messages are reported back via the
 * partial-batch-failure contract, so the CDK event source must enable
 * `reportBatchItemFailures`.
 */
export function createQueueHandler<T extends object>(
  Ctor: Ctor<T>,
  method: keyof T & string,
): (event: SQSEvent, context: Context) => Promise<SQSBatchResponse> {
  let instance: T | undefined;
  return async (event, context) => {
    instance ??= new Ctor();
    const fn = instance[method] as unknown;
    if (typeof fn !== "function") {
      throw new Error(`@Queue target ${Ctor.name}.${method} is not a method`);
    }
    const consumer = (fn as QueueConsumer).bind(instance);

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
