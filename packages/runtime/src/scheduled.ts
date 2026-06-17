import type { Context, Handler } from "aws-lambda";

type Ctor<T> = new () => T;

/** A standalone scheduled function registered via `cron(...)`. */
export type ScheduledFn = (event: unknown, context: Context) => unknown | Promise<unknown>;

/**
 * Builds the Lambda handler for a `@Cron` method or `cron()` function. EventBridge
 * invokes this on a schedule.
 *
 * - Function form (`createScheduledHandler(fn)`): just calls the function.
 * - Method form (`createScheduledHandler(Ctor, "method")`): instantiates the class
 *   once (cached across warm invocations — v1 assumes a no-arg constructor) and
 *   calls the decorated method.
 */
export function createScheduledHandler(handler: ScheduledFn): Handler;
export function createScheduledHandler<T extends object>(Ctor: Ctor<T>, method: keyof T & string): Handler;
export function createScheduledHandler<T extends object>(
  target: Ctor<T> | ScheduledFn,
  method?: keyof T & string,
): Handler {
  if (method === undefined) {
    const fn = target as ScheduledFn;
    return async (event, context) => await fn(event, context);
  }
  const Ctor = target as Ctor<T>;
  let instance: T | undefined;
  return async (event, context) => {
    instance ??= new Ctor();
    const fn = instance[method] as unknown;
    if (typeof fn !== "function") {
      throw new Error(`@Cron target ${Ctor.name}.${String(method)} is not a method`);
    }
    return await (fn as (...args: unknown[]) => unknown).call(instance, event, context);
  };
}
