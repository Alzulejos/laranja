/**
 * Lightweight failure diagnostics. The CLI runs one command per process, so a
 * single module-level "current run" tracks which command is executing, which
 * step it's on, and any context worth attaching (project, region, deployment id).
 *
 * When a command throws, the top-level handler builds a structured report and
 * appends it to `~/.laranja/errors.jsonl` — so a half-way failure leaves a record
 * of WHAT failed, in WHICH step, and WHY. Shaped so we can also POST it to the
 * dashboard later; for now it's logged locally.
 */
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { authDir, loadConfig, resolveApiKey, postReport } from "@alzulejos/laranja-core";

interface RunState {
  command: string;
  projectDir?: string;
  step: string;
  startedAt: number;
  fields: Record<string, unknown>;
}

let run: RunState = { command: "", step: "starting", startedAt: Date.now(), fields: {} };

/** Begin tracking a command run (called by the dispatcher before the command). */
export function beginRun(command: string, projectDir?: string): void {
  run = { command, projectDir, step: "starting", startedAt: Date.now(), fields: {} };
}

/** Mark the current step; it's surfaced in the failure report if something throws. */
export function step(name: string): void {
  run.step = name;
}

/** Attach context to the run (project, stage, region, deploymentId, …). */
export function note(fields: Record<string, unknown>): void {
  Object.assign(run.fields, fields);
}

export interface FailureReport {
  command: string;
  step: string;
  reason: string;
  errorName?: string;
  stack?: string;
  durationMs: number;
  at: string;
  fields: Record<string, unknown>;
}

/** Build the structured report for a thrown error against the current run. */
export function buildFailureReport(err: unknown): FailureReport {
  const e = err instanceof Error ? err : undefined;
  return {
    command: run.command,
    step: run.step,
    reason: e?.message ?? String(err),
    errorName: e?.name,
    stack: e?.stack,
    durationMs: Date.now() - run.startedAt,
    at: new Date().toISOString(),
    fields: run.fields,
  };
}

/**
 * Append the report as one JSON line to `~/.laranja/errors.jsonl`. Best-effort:
 * returns the path written, or undefined if the log couldn't be written (logging
 * a failure must never itself crash the CLI).
 */
export function writeFailureReport(report: FailureReport): string | undefined {
  try {
    const dir = authDir();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "errors.jsonl");
    appendFileSync(file, JSON.stringify(report) + "\n");
    return file;
  } catch {
    return undefined;
  }
}

/**
 * POST the report to the dashboard (`/report`), scoped to the user (api key) +
 * project (project id from the run's config). Best-effort: returns whether it was
 * sent. Skipped silently when not logged in or the project has no id — and never
 * throws, so a failed send can't compound the original failure.
 */
export async function sendFailureReport(report: FailureReport): Promise<boolean> {
  const apiKey = resolveApiKey();
  if (!apiKey || !run.projectDir) return false;
  let projectId: string | undefined;
  try {
    projectId = (await loadConfig(run.projectDir)).projectId;
  } catch {
    return false; // no/unreadable config — nothing to scope the report to
  }
  if (!projectId) return false;
  try {
    await postReport(report as unknown as Record<string, unknown>, apiKey, projectId);
    return true;
  } catch {
    return false;
  }
}
