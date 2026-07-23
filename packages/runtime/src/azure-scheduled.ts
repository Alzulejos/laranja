import { app as functionsApp, type Timer, type InvocationContext } from "@azure/functions";
import { azureCronScheduleSettingKey } from "@alzulejos/laranja-core";
import { makeScheduledInvoker, type ScheduledFn } from "./scheduled.js";

type Ctor<T> = new () => T;

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
