import * as ui from "./ui.js";

/**
 * Fire a dashboard report without letting a reporting failure mask the AWS
 * operation. Deploy/destroy still succeed (or fail) on their own terms even if
 * the dashboard is unreachable — we just warn.
 */
export async function reportSafely(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ui.warn(`couldn't ${what} to the dashboard (${err instanceof Error ? err.message : String(err)})`);
  }
}
