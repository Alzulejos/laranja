import type { Context, Handler, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { runSqsBatch, type QueueConsumer } from "./queue.js";

/** A DI‑resolvable provider + the method to invoke on it. */
export type DispatchEntry = [Ctor<object>, string];

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

/** Build (once) the context, resolve the provider, and pull the target method off it.
 *  `method` is a plain string (the dispatch tables carry `[Provider, "name"]`), so
 *  there's no compile-time `keyof` guard here — the runtime check below catches a
 *  bad name. */
function resolveMethod<T extends object>(
  ctx: NestContextLike,
  Ctor: Ctor<T>,
  method: string,
  kind: "@Cron" | "@Queue",
): (...args: unknown[]) => unknown {
  const instance = ctx.get(Ctor);
  const fn = (instance as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    throw new Error(`${kind} target ${Ctor.name}.${method} is not a method`);
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

/** The declared queue name is the last `:`‑segment of an SQS `eventSourceARN`
 *  (`arn:aws:sqs:<region>:<acct>:<name>`); laranja names the queue = its declared
 *  name, so this maps a record straight back to the routing table key. */
function queueNameFromArn(arn: string): string {
  return arn.slice(arn.lastIndexOf(":") + 1);
}

function isSqsEvent(event: unknown): event is SQSEvent {
  return !!event && typeof event === "object" && Array.isArray((event as { Records?: unknown }).Records);
}

/**
 * The consolidated worker handler: ONE Lambda for a whole `workers()` module,
 * hosting all its `@Cron` and `@Queue` methods. It builds the module's DI context
 * once (cached across warm invocations) and routes by event shape —
 *
 *  - **SQS** (`Records` present): each record → the consumer for its source queue,
 *    looked up by `eventSourceARN`, through the partial‑batch‑failure contract.
 *  - **EventBridge**: our schedules pass `{ handler: "<cronId>" }` → the cron method.
 *
 * The routing tables map an id to `[Provider, method]`; the provider resolves
 * through DI so injected dependencies work exactly as in the app.
 */
export function createNestWorkerDispatcher(
  contextFactory: NestContextFactory,
  tables: { crons: Record<string, DispatchEntry>; queues: Record<string, DispatchEntry> },
): Handler {
  let ctx: NestContextLike | undefined;
  const getCtx = async (): Promise<NestContextLike> => (ctx ??= await contextFactory());

  return (async (event: unknown, context: Context) => {
    if (isSqsEvent(event)) {
      const c = await getCtx();
      const consumer: QueueConsumer = (body, record, ctx2) => {
        const name = queueNameFromArn(record.eventSourceARN);
        const entry = tables.queues[name];
        if (!entry) throw new Error(`worker: no @Queue consumer for "${name}"`);
        return resolveMethod(c, entry[0], entry[1], "@Queue")(body, record, ctx2);
      };
      return runSqsBatch(consumer, event, context);
    }
    const handlerId = (event as { handler?: string } | null)?.handler;
    const entry = handlerId ? tables.crons[handlerId] : undefined;
    if (!entry) throw new Error(`worker: no @Cron handler for "${String(handlerId)}"`);
    return await resolveMethod(await getCtx(), entry[0], entry[1], "@Cron")(event, context);
  }) as Handler;
}
