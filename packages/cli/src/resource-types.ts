import path from "node:path";
import { writeFileSync } from "node:fs";
import type { InfraIR } from "@alzulejos/laranja-core";
import { generateResourceTypes } from "@alzulejos/laranja-scanner";

/** Filename of the generated, committed resource-id types at the project root. */
export const RESOURCE_TYPES_FILE = "laranja.types.ts";

/**
 * (Re)write `<project>/laranja.types.ts` from the scanned IR so the config's
 * `resources` keys are type-checked against the project's real resource ids.
 * Best-effort: a write failure must never block a deploy/synth/eject.
 */
export function writeResourceTypes(projectDir: string, ir: InfraIR): void {
  try {
    writeFileSync(path.join(projectDir, RESOURCE_TYPES_FILE), generateResourceTypes(ir));
  } catch {
    // Non-fatal: typing is a convenience; the scan-time hard error is the backstop.
  }
}
