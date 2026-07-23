import type { Context, Handler } from "aws-lambda";

type Ctor<T> = new () => T;

/** A standalone scheduled function registered via `cron(...)`. */
export type ScheduledFn = (event: unknown, context: Context) => unknown | Promise<unknown>;

/**
 * Provider-neutral invocation of a `@Cron` method or `cron()` function. The
 * dispatch (function vs class method) and the once-per-process instance cache are
 * identical whatever triggers it, so both the AWS Lambda handler and the Azure
 * timer registration build on this rather than each re-deriving it.
 *
 * - Function form (`makeScheduledInvoker(fn)`): calls the function.
 * - Method form (`makeScheduledInvoker(Ctor, "method")`): instantiates the class
 *   once (cached across warm invocations — v1 assumes a no-arg constructor) and
 *   calls the decorated method.
 */
export type ScheduledInvoker = (event: unknown, context: unknown) => Promise<unknown>;

export function makeScheduledInvoker(handler: ScheduledFn): ScheduledInvoker;
export function makeScheduledInvoker<T extends object>(Ctor: Ctor<T>, method: keyof T & string): ScheduledInvoker;
export function makeScheduledInvoker<T extends object>(
  target: Ctor<T> | ScheduledFn,
  method?: keyof T & string,
): ScheduledInvoker {
  if (method === undefined) {
    const fn = target as ScheduledFn;
    return async (event, context) => await fn(event, context as Context);
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

/**
 * Builds the Lambda handler for a `@Cron` method or `cron()` function. EventBridge
 * invokes this on a schedule. Thin adapter over `makeScheduledInvoker` — the
 * dispatch lives there so Azure's timer registration shares it exactly.
 */
export function createScheduledHandler(handler: ScheduledFn): Handler;
export function createScheduledHandler<T extends object>(Ctor: Ctor<T>, method: keyof T & string): Handler;
export function createScheduledHandler<T extends object>(
  target: Ctor<T> | ScheduledFn,
  method?: keyof T & string,
): Handler {
  // Overloads guarantee the arg pairing; the cast just picks the right signature.
  const invoke = (
    method === undefined
      ? makeScheduledInvoker(target as ScheduledFn)
      : makeScheduledInvoker(target as Ctor<T>, method)
  );
  return async (event, context) => await invoke(event, context);
}
