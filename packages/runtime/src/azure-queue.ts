import { app as functionsApp, type InvocationContext } from "@azure/functions";
import { queueUrlEnvName } from "@alzulejos/laranja-core";
import type { Context, SQSRecord } from "aws-lambda";
import { makeQueueConsumer, parseQueueBody, type QueueConsumer } from "./queue.js";

type Ctor<T> = new () => T;

/**
 * Register a `queue()` / `@Queue` handler as a Storage-Queue-triggered function on
 * the Azure Functions host.
 *
 * Like `registerAzureCron`, this is a SIDE EFFECT: the host discovers functions by
 * loading the package and reading what it registered, so the generated shim calls
 * this at module top level rather than exporting a symbol. Several queues plus the
 * HTTP function register into the ONE Function App the package deploys.
 *
 * The physical queue name is NOT baked in — it's bound to an app setting via the
 * host's `%NAME%` expansion, and laranja-cdk writes that setting to the queue's
 * physical name. `queueUrlEnvName` (shared with laranja-cdk through core) is the
 * SAME key the producer reads, so `name` MUST be the queue name the back half used.
 *
 * `connection: "AzureWebJobsStorage"` resolves to the identity-based config the
 * back half wired (`AzureWebJobsStorage__queueServiceUri` + `__credential`), so the
 * trigger reads the queue with the app's managed identity — no connection string.
 */
export function registerAzureQueue(name: string, handler: QueueConsumer): void;
export function registerAzureQueue<T extends object>(name: string, Ctor: Ctor<T>, method: keyof T & string): void;
export function registerAzureQueue<T extends object>(
  name: string,
  target: Ctor<T> | QueueConsumer,
  method?: keyof T & string,
): void {
  const consumer =
    method === undefined
      ? makeQueueConsumer(target as QueueConsumer)
      : makeQueueConsumer(target as Ctor<T>, method);

  functionsApp.storageQueue(name, {
    // `%…%` expands from app settings at load time; laranja-cdk sets this key to the
    // physical queue name. Same key the producer reads, so both sides target one queue.
    queueName: `%${queueUrlEnvName(name)}%`,
    connection: "AzureWebJobsStorage",
    handler: async (queueEntry: unknown, context: InvocationContext) => {
      // The consumer's contract is the parsed body; the second/third args are the
      // provider's raw message + invocation handles. Azure has no SQSRecord, so the
      // trigger metadata stands in for it — a cast the boundary owns, not the user.
      await consumer(
        parseQueueBody(queueEntry),
        context.triggerMetadata as unknown as SQSRecord,
        context as unknown as Context,
      );
    },
  });
}
