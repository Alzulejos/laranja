import type { Handler } from "aws-lambda";

type Ctor<T> = new () => T;

/**
 * Builds the Lambda handler for an `@Cron` method. EventBridge invokes this on a
 * schedule; we instantiate the class once (cached across warm invocations — v1
 * assumes a no-arg constructor) and call the decorated method.
 */
export function createScheduledHandler<T extends object>(Ctor: Ctor<T>, method: keyof T & string): Handler {
  let instance: T | undefined;
  return async (event, context) => {
    instance ??= new Ctor();
    const fn = instance[method] as unknown;
    if (typeof fn !== "function") {
      throw new Error(`@Cron target ${Ctor.name}.${method} is not a method`);
    }
    return await (fn as (...args: unknown[]) => unknown).call(instance, event, context);
  };
}
