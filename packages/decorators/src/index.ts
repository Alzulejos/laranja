/**
 * The decorators the user applies to their job classes.
 *
 * These are intentionally near-no-ops at runtime: the *scanner* discovers them
 * statically (via ts-morph) and bakes class + method names into generated Lambda
 * entry shims. The runtime metadata registry below exists only so that future
 * runtime-reflection paths (and tooling/tests) can enumerate handlers too.
 */

// Re-export the schedule builders + types so users import them alongside @Cron.
// `CronExpression` is the `@nestjs/schedule` enum, mirrored so a Nest user can
// repoint their import at laranja and keep their existing @Cron(CronExpression.X).
export { rate, every, CronExpression } from "@alzulejos/laranja-core";
export type { RateUnit, Schedule, ScheduleInput } from "@alzulejos/laranja-core";

import type { ScheduleInput } from "@alzulejos/laranja-core";

/** Options object `@nestjs/schedule`'s `@Cron` accepts as its SECOND argument. */
export interface NestCronOptions {
  /** Stable name for the job — laranja uses it as the resource id. */
  name?: string;
  /** IANA timezone the schedule is evaluated in. */
  timeZone?: string;
  /** Present for signature compatibility; ignored by laranja's static scan. */
  utcOffset?: number | string;
  disabled?: boolean;
}

export interface CronOptions {
  /** A `rate(...)`/`every(...)` builder result, or a raw provider string. */
  schedule: ScheduleInput;
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

/** The shape of a standalone handler passed to `cron()` / `queue()`. */
export type JobHandler = (...args: any[]) => unknown | Promise<unknown>;

function registerFunction(kind: HandlerKind, handler: JobHandler, options: CronOptions | QueueOptions): void {
  const name = handler.name || "(anonymous)";
  handlerRegistry.push({ kind, className: name, method: name, options });
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
export function Cron(schedule: ScheduleInput): MethodDecorator;
export function Cron(options: CronOptions): MethodDecorator;
/** `@nestjs/schedule`-compatible form: a cron string/expression + optional options. */
export function Cron(expression: string, options?: NestCronOptions): MethodDecorator;
export function Cron(arg: ScheduleInput | CronOptions, _nestOptions?: NestCronOptions): MethodDecorator {
  // The second (Nest) argument is read statically by the scanner (name -> id,
  // timeZone -> timezone); at runtime this decorator is a near-no-op registry write.
  const options = toCronOptions(arg);
  return (target, propertyKey) => {
    register("cron", target, propertyKey, options);
  };
}

/**
 * `@nestjs/schedule`-compatible `@Interval`. Runs a method every N milliseconds;
 * laranja lowers it to an EventBridge `rate(...)`, so the interval must be a whole
 * number of minutes (EventBridge's floor). Discovered statically by the scanner.
 *
 * @example
 *   @Interval(300000)          // every 5 minutes
 *   @Interval("poll", 300000)  // named
 */
export function Interval(milliseconds: number): MethodDecorator;
export function Interval(name: string, milliseconds: number): MethodDecorator;
export function Interval(_a: string | number, _b?: number): MethodDecorator {
  return (target, propertyKey) => {
    register("cron", target, propertyKey, { schedule: "" });
  };
}

/**
 * `@nestjs/schedule`-compatible `@Timeout`. Present so swapped imports compile,
 * but a one-shot timer relative to process start has no serverless equivalent —
 * the scanner rejects it at build time with a clear message.
 */
export function Timeout(milliseconds: number): MethodDecorator;
export function Timeout(name: string, milliseconds: number): MethodDecorator;
export function Timeout(_a: string | number, _b?: number): MethodDecorator {
  return () => {};
}

/** Normalize the `Cron`/`cron` first argument (raw string, Schedule, or full options) into CronOptions. */
function toCronOptions(arg: ScheduleInput | CronOptions): CronOptions {
  if (typeof arg === "string") return { schedule: arg };
  if ("kind" in arg) return { schedule: arg }; // a Schedule object
  return arg; // already CronOptions
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

/**
 * Function-style counterpart to `@Cron` — for codebases that don't use classes.
 * Register a standalone exported function on a schedule. The function's name
 * becomes the resource id (unless you pass an explicit `id`). Like the
 * decorators, this is a near-no-op at runtime: the scanner reads it statically.
 *
 * @example
 *   export async function refreshCache() {}
 *   cron(rate(5, "minutes"), refreshCache);
 */
export function cron(schedule: ScheduleInput, handler: JobHandler): void;
export function cron(options: CronOptions, handler: JobHandler): void;
export function cron(arg: ScheduleInput | CronOptions, handler: JobHandler): void {
  registerFunction("cron", handler, toCronOptions(arg));
}

/**
 * Function-style counterpart to `@Queue`. Register a standalone exported function
 * as an SQS consumer.
 *
 * @example
 *   export async function sendEmails(body: unknown) {}
 *   queue({ name: "emails", batchSize: 10 }, sendEmails);
 */
export function queue(options: QueueOptions, handler: JobHandler): void {
  registerFunction("queue", handler, options);
}

/**
 * Marks the HTTP app (the proxy target) for laranja, code-first. Export the
 * result so the scanner (and the generated shim) can find it:
 *
 *   export default http(app);          // or
 *   export const api = http(app);
 *
 * Identity at runtime: it returns the app untouched. The scanner reads it
 * statically; omit it entirely for a workers-only deployment.
 */
export function http<T>(app: T): T {
  return app;
}

/**
 * Declare the Nest module laranja resolves background workers (@Cron / @Queue)
 * against — code-first, the DI counterpart to `http()`. Export the result so the
 * scanner (and the generated worker shims) can find it:
 *
 *   export default workers(AppModule);        // or
 *   export const jobs = workers(AppModule);
 *
 * At runtime laranja builds a standalone Nest context from this module
 * (`NestFactory.createApplicationContext`) so each worker Lambda resolves its
 * provider — and that provider's injected dependencies — through real DI instead
 * of a bare `new`. Pass `AppModule` for the whole graph, or a leaner module you
 * compose if you want a smaller cold start. Identity at runtime: returns the
 * module untouched; only Nest projects with crons/queues need it.
 */
export function workers<T>(module: T): T {
  return module;
}

/**
 * Declare an environment variable your code needs at runtime — code-first.
 *
 * At runtime this is nothing more than a read of `process.env[name]`. Its value
 * to laranja is *static discovery*: the scanner finds every `env("NAME")` call
 * (NAME must be a string literal) and records the name in the IR. The deploy
 * step then resolves each name from your shell / CI `process.env` and populates
 * the Lambda's environment for you — no more filling vars in the console.
 *
 * Only the NAME crosses the wire to the server; the VALUE is resolved on your
 * machine at deploy time and never leaves it.
 *
 * @example
 *   const dbUrl = env("DATABASE_URL");
 */
export function env(name: string): string | undefined {
  return process.env[name];
}
