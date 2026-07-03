import type { Context, Handler, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { runSqsBatch, type QueueConsumer } from "./queue.js";

/**
 * Nest-backed worker handlers. Unlike the Express path — where a `@Cron`/`@Queue`
 * class is `new`'d directly — a Nest provider's method depends on injected
 * services, so we must resolve the instance through the DI container. The
 * generated shim hands us a factory that builds a standalone Nest context
 * (`NestFactory.createApplicationContext(WorkersModule)`); we build it once, cache
 * it across warm invocations, and pull the provider out with `context.get()`.
 *
 * Kept structural (no `@nestjs/*` import) so the runtime package stays
 * framework-agnostic — the shim, generated inside the user's Nest project, is what
 * imports `NestFactory`.
 */

/** The slice of a Nest `INestApplicationContext` we use: DI resolution by class. */
export interface NestContextLike {
  get<T>(type: new (...args: any[]) => T): T;
}

/** Builds the standalone Nest context. Async in Nest (`createApplicationContext`). */
export type NestContextFactory = () => NestContextLike | Promise<NestContextLike>;

type Ctor<T> = new (...args: any[]) => T;

/** Build (once) the context, resolve the provider, and pull the target method off it. */
function resolveMethod<T extends object>(
  ctx: NestContextLike,
  Ctor: Ctor<T>,
  method: keyof T & string,
  kind: "@Cron" | "@Queue",
): (...args: unknown[]) => unknown {
  const instance = ctx.get(Ctor);
  const fn = instance[method] as unknown;
  if (typeof fn !== "function") {
    throw new Error(`${kind} target ${Ctor.name}.${String(method)} is not a method`);
  }
  return (fn as (...args: unknown[]) => unknown).bind(instance);
}

/** The Nest counterpart to `createScheduledHandler` — resolves the provider via DI. */
export function createNestScheduledHandler<T extends object>(
  contextFactory: NestContextFactory,
  Ctor: Ctor<T>,
  method: keyof T & string,
): Handler {
  let call: ((...args: unknown[]) => unknown) | undefined;
  return (async (event, context) => {
    call ??= resolveMethod(await contextFactory(), Ctor, method, "@Cron");
    return await call(event, context);
  }) as Handler;
}

/** The Nest counterpart to `createQueueHandler` — resolves the consumer via DI. */
export function createNestQueueHandler<T extends object>(
  contextFactory: NestContextFactory,
  Ctor: Ctor<T>,
  method: keyof T & string,
): (event: SQSEvent, context: Context) => Promise<SQSBatchResponse> {
  let consumer: QueueConsumer | undefined;
  return async (event, context) => {
    consumer ??= resolveMethod(await contextFactory(), Ctor, method, "@Queue") as QueueConsumer;
    return runSqsBatch(consumer, event, context);
  };
}
