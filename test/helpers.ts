import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LaranjaConfig } from "@alzulejos/laranja-core";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Temp projects live INSIDE the repo so Vitest's fs allowlist can transform configs. */
const TMP_ROOT = path.join(here, ".tmp");

const created: string[] = [];

/**
 * Write a set of files (path → contents, relative to the project root) into a
 * fresh temp project dir and return its absolute path. Cleaned up after each test.
 */
export function makeProject(files: Record<string, string>): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_ROOT, "proj-"));
  created.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return dir;
}

/** Remove every project created during the run. */
export function cleanupProjects(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A scan-ready config (loadConfig's defaults already applied). */
export function cfg(overrides: Partial<LaranjaConfig> = {}): LaranjaConfig {
  return { name: "test-app", stage: "dev", env: {}, ...overrides };
}
