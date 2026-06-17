/**
 * The decorators the user applies to their job classes.
 *
 * These are intentionally near-no-ops at runtime: the *scanner* discovers them
 * statically (via ts-morph) and bakes class + method names into generated Lambda
 * entry shims. The runtime metadata registry below exists only so that future
 * runtime-reflection paths (and tooling/tests) can enumerate handlers too.
 */

// Re-export the AWS-native schedule builders so users import them alongside @Cron.
export { rate, every } from "@laranja/core";
export type { RateUnit } from "@laranja/core";

export interface CronOptions {
  schedule: string;
  /** Stable logical id. Defaults to "<Class>-<method>". */
  id?: string;
}

export interface QueueOptions {
  /** Queue name. A ".fifo" suffix (or `fifo: true`) marks a FIFO queue. */
  name: string;
  batchSize?: number;
  fifo?: boolean;
}

export type HandlerKind = "cron" | "queue";

export interface RegisteredHandler {
  kind: HandlerKind;
  className: string;
  method: string;
  options: CronOptions | QueueOptions;
}

/** Module-level registry, populated when decorated classes are imported. */
export const handlerRegistry: RegisteredHandler[] = [];

function register(kind: HandlerKind, target: object, method: string | symbol, options: CronOptions | QueueOptions): void {
  handlerRegistry.push({
    kind,
    className: (target as { constructor: { name: string } }).constructor.name,
    method: String(method),
    options,
  });
}

/**
 * Schedules a method on an EventBridge rule. Each `@Cron` becomes its own Lambda.
 *
 * @example
 *   @Cron("rate(5 minutes)")
 *   async refreshCache() {}
 *
 *   @Cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" })
 *   async dailyReport() {}
 */
export function Cron(schedule: string): MethodDecorator;
export function Cron(options: CronOptions): MethodDecorator;
export function Cron(arg: string | CronOptions): MethodDecorator {
  const options: CronOptions = typeof arg === "string" ? { schedule: arg } : arg;
  return (target, propertyKey) => {
    register("cron", target, propertyKey, options);
  };
}

/**
 * Consumes messages from an SQS queue. Each `@Queue` becomes its own Lambda.
 *
 * @example
 *   @Queue({ name: "emails", batchSize: 10 })
 *   async sendEmails(event: unknown) {}
 */
export function Queue(options: QueueOptions): MethodDecorator {
  return (target, propertyKey) => {
    register("queue", target, propertyKey, options);
  };
}
