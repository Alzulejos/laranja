import { app as functionsApp, type Timer, type InvocationContext } from "@azure/functions";
import { azureCronScheduleSettingKey } from "@alzulejos/laranja-core";
import { makeScheduledInvoker, type ScheduledFn, type ScheduledInvoker } from "./scheduled.js";
import { resolveMethod, type NestContextFactory } from "./nest-worker.js";

type Ctor<T> = new () => T;

/**
 * Bind an invoker to a timer-triggered function. Shared by the plain and the
 * Nest/DI-backed registrations so the trigger contract — the app-setting schedule
 * binding below — lives in exactly one place.
 */
function registerTimer(name: string, invoke: ScheduledInvoker): void {
  functionsApp.timer(name, {
    // `%…%` expands from app settings at trigger time; laranja-cdk sets this key
    // to the NCRONTAB schedule. Keeping the schedule out of the package means a
    // schedule change is an app-settings update, not a repackage.
    schedule: `%${azureCronScheduleSettingKey(name)}%`,
    handler: async (timer: Timer, context: InvocationContext) => {
      await invoke(timer, context);
    },
  });
}

/**
 * Register a `cron()` / `@Cron` handler as a timer-triggered function on the
 * Azure Functions host.
 *
 * Like `registerAzureHttp`, this is a SIDE EFFECT: the host discovers functions
 * by loading the package and reading what it registered, so the generated shim
 * calls this at module top level rather than exporting a symbol. Several crons
 * plus the HTTP function register into the ONE Function App the package deploys.
 *
 * The schedule is NOT baked in here — it's bound to an app setting via NCRONTAB's
 * `%NAME%` expansion, and laranja-cdk writes that setting to the lowered NCRONTAB
 * string. `azureCronScheduleSettingKey` (shared with laranja-cdk through core) is
 * what keeps the two sides naming the same setting, so `name` MUST be the cron id
 * the back half used.
 */
export function registerAzureCron(name: string, handler: ScheduledFn): void;
export function registerAzureCron<T extends object>(name: string, Ctor: Ctor<T>, method: keyof T & string): void;
export function registerAzureCron<T extends object>(
  name: string,
  target: Ctor<T> | ScheduledFn,
  method?: keyof T & string,
): void {
  const invoke =
    method === undefined
      ? makeScheduledInvoker(target as ScheduledFn)
      : makeScheduledInvoker(target as Ctor<T>, method);

  registerTimer(name, invoke);
}

/**
 * The Nest counterpart to `registerAzureCron`: a `@Cron` method whose provider
 * resolves through DI rather than a bare `new`.
 *
 * `contextFactory` is the memoized `nestContext(...)` the shim shares across every
 * function belonging to the same `workers()` root, so the module's container is
 * built once per process no matter which trigger fires first. The resolved method
 * is then cached for the life of the process, like the AWS handler's.
 */
export function registerAzureNestCron<T extends object>(
  name: string,
  contextFactory: NestContextFactory,
  Ctor: new (...args: any[]) => T,
  method: keyof T & string,
): void {
  let call: ((...args: unknown[]) => unknown) | undefined;
  registerTimer(name, async (event, context) => {
    call ??= resolveMethod(await contextFactory(), Ctor, method, "@Cron");
    return await call(event, context);
  });
}
