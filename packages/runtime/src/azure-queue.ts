import { app as functionsApp, type InvocationContext } from "@azure/functions";
import { queueUrlEnvName, azurePoisonQueueEnvName } from "@alzulejos/laranja-core";
import type { Context, SQSRecord } from "aws-lambda";
import { makeQueueConsumer, parseQueueBody, type QueueConsumer } from "./queue.js";
import { resolveMethod, type NestContextFactory } from "./nest-worker.js";

type Ctor<T> = new () => T;

/**
 * Bind a consumer to a Storage-Queue-triggered function. Shared by the plain, the
 * Nest/DI-backed and the poison registrations so the trigger contract — the app-setting
 * queue binding and the identity-based connection below — lives in exactly one place.
 *
 * `functionName` and `settingKey` are separate because a poison binding is a DIFFERENT
 * physical queue from the function's own name: the trigger reads `<source>-poison` while
 * the function is named for the source it drains.
 */
function registerQueueTrigger(
  functionName: string,
  settingKey: string,
  resolveConsumer: () => Promise<QueueConsumer>,
): void {
  functionsApp.storageQueue(functionName, {
    // `%…%` expands from app settings at load time; laranja-cdk sets this key to the
    // physical queue name. Same key the producer reads, so both sides target one queue.
    queueName: `%${settingKey}%`,
    connection: "AzureWebJobsStorage",
    handler: async (queueEntry: unknown, context: InvocationContext) => {
      const consumer = await resolveConsumer();
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

  registerQueueTrigger(name, queueUrlEnvName(name), async () => consumer);
}

/**
 * The function name for a source queue's poison drain. Derived, so the shim and the
 * back half don't have to agree on anything beyond the source name — and unique within
 * the app, since Azure gives each source exactly one poison queue.
 */
function poisonFunctionName(sourceQueueName: string): string {
  return `${sourceQueueName}-poison`;
}

/**
 * Drain a source queue's POISON queue into the consumer declared as its DLQ.
 *
 * Azure's dead-letter destination isn't configurable — the host always moves a message
 * that failed `maxDequeueCount` times to `<queue>-poison`. But that's an ordinary
 * Storage Queue, so binding a trigger on it delivers those failures into the handler the
 * user declared via `dlq`. Without this the declared DLQ consumer receives nothing on
 * Azure while failures accumulate unread.
 *
 * This is an ADDITIONAL registration: the DLQ queue keeps its own trigger and stays
 * something you can `getQueue(...).send()` to. The consumer therefore sees both messages
 * sent to it directly and messages drained from the source's poison queue.
 */
export function registerAzurePoisonQueue(sourceQueueName: string, handler: QueueConsumer): void;
export function registerAzurePoisonQueue<T extends object>(
  sourceQueueName: string,
  Ctor: Ctor<T>,
  method: keyof T & string,
): void;
export function registerAzurePoisonQueue<T extends object>(
  sourceQueueName: string,
  target: Ctor<T> | QueueConsumer,
  method?: keyof T & string,
): void {
  const consumer =
    method === undefined
      ? makeQueueConsumer(target as QueueConsumer)
      : makeQueueConsumer(target as Ctor<T>, method);

  registerQueueTrigger(
    poisonFunctionName(sourceQueueName),
    azurePoisonQueueEnvName(sourceQueueName),
    async () => consumer,
  );
}

/**
 * The Nest counterpart to `registerAzurePoisonQueue`: drains a source's poison queue
 * into a `@Queue` provider method resolved through the shared DI container.
 */
export function registerAzureNestPoisonQueue<T extends object>(
  sourceQueueName: string,
  contextFactory: NestContextFactory,
  Ctor: new (...args: any[]) => T,
  method: keyof T & string,
): void {
  let consumer: QueueConsumer | undefined;
  registerQueueTrigger(
    poisonFunctionName(sourceQueueName),
    azurePoisonQueueEnvName(sourceQueueName),
    async () => {
      consumer ??= resolveMethod(await contextFactory(), Ctor, method, "@Queue") as QueueConsumer;
      return consumer;
    },
  );
}

/**
 * The Nest counterpart to `registerAzureQueue`: a `@Queue` method whose provider
 * resolves through DI rather than a bare `new`.
 *
 * `contextFactory` is the memoized `nestContext(...)` the shim shares across every
 * function belonging to the same `workers()` root, so the module's container is
 * built once per process no matter which trigger fires first. The resolved consumer
 * is then cached for the life of the process, like the AWS handler's.
 *
 * There's no partial-batch contract to honor here: Azure delivers one message per
 * invocation, so a throw fails that message alone and the host applies its own
 * retry/poison-queue policy.
 */
export function registerAzureNestQueue<T extends object>(
  name: string,
  contextFactory: NestContextFactory,
  Ctor: new (...args: any[]) => T,
  method: keyof T & string,
): void {
  let consumer: QueueConsumer | undefined;
  registerQueueTrigger(name, queueUrlEnvName(name), async () => {
    consumer ??= resolveMethod(await contextFactory(), Ctor, method, "@Queue") as QueueConsumer;
    return consumer;
  });
}
