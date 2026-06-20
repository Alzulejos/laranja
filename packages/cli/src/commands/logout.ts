import { authFilePath, clearAuth } from "@laranja/core";
import * as ui from "../ui.js";

/**
 * Remove the stored API key (~/.laranja/auth.json). Lets you switch accounts —
 * after logging out, the next `laranja init` prompts for a key again.
 */
export async function logout(): Promise<void> {
  if (clearAuth()) {
    console.log(`\n  ${ui.green("✓")} Logged out — removed ${ui.dim(authFilePath())}.`);
  } else {
    console.log(`\n  ${ui.dim("You're not logged in — nothing to remove.")}`);
  }
}
