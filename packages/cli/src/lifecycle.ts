import * as ui from "./ui.js";

/**
 * Fire a *post-gate* dashboard status report without letting a reporting failure
 * mask the AWS operation. Deploy/destroy still succeed (or fail) on their own
 * terms even if the dashboard is unreachable — we just warn.
 *
 * Use this ONLY for lifecycle telemetry that runs after the command is already
 * authorized (STARTED / SUCCESS / FAILED / resources). Never wrap the permission
 * gate — the call that authenticates the key and opens the deployment/teardown
 * row — in this; that call must be fail-closed so an auth error aborts before we
 * touch the user's cloud.
 */
export async function reportSafely(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ui.warn(`couldn't ${what} to the dashboard (${err instanceof Error ? err.message : String(err)})`);
  }
}
