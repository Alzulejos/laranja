/**
 * `laranja logs` for Azure — read the app's logs from Application Insights.
 *
 * Azure has no CloudWatch-style live tail; function output lands in Application
 * Insights (the Log Analytics workspace this app created), queried with KQL.
 * `--follow` polls for new events. Note App Insights has an ingestion delay of
 * ~1–2 minutes, so "live" is near-real-time, not instant — surfaced to the user.
 */

import {
  azureLogWorkspaceName,
  loadConfig,
} from "@alzulejos/laranja-core";
import { logAnalyticsWorkspaceId, queryAppLogs, type LogRow } from "../azure.js";
import { note } from "../diagnostics.js";
import * as ui from "../ui.js";
import type { LogsOptions } from "./logs.js";
import { parseSince } from "./logs.js";

const POLL_MS = 5000;

export async function logsAzure(projectDir: string, opts: LogsOptions = {}): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  note({ project: config.name, stage: config.stage });

  ui.header(`logs ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} azure/${config.azure!.resourceGroup}`);

  const target = {
    subscriptionId: config.azure!.subscriptionId,
    resourceGroup: config.azure!.resourceGroup,
  };
  const workspace = azureLogWorkspaceName(config.name, config.stage);

  const sp = ui.spinner("finding logs");
  const workspaceId = await logAnalyticsWorkspaceId(target, workspace);
  sp.stop();
  if (!workspaceId) {
    throw new Error(`No Log Analytics workspace for "${config.name}" (${config.stage}) — deploy it first.`);
  }

  const sinceMs = parseSince(opts.since ?? "1h");

  // History window first (always, since there's no instant tail to fall into).
  const history = await queryAppLogs(workspaceId, sinceMs);
  for (const row of history) printRow(row);
  if (history.length === 0) console.log(`  ${ui.dim("(no events in window)")}`);

  if (opts.follow === false) return;

  // Follow: poll for events newer than the last one we printed.
  ui.note("App Insights has a ~1–2 min ingestion delay, so live output isn't instant. Ctrl-C to stop.");
  let lastSeen = history.length ? history[history.length - 1].timestamp : Date.now() - sinceMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(POLL_MS);
    const rows = await queryAppLogs(workspaceId, sinceMs, lastSeen + 1);
    for (const row of rows) {
      printRow(row);
      lastSeen = Math.max(lastSeen, row.timestamp);
    }
  }
}

function printRow(row: LogRow): void {
  const msg = row.message.replace(/\n$/, "");
  if (!msg) return;
  const ts = ui.dim(new Date(row.timestamp).toISOString().slice(11, 23));
  const sev =
    row.severity === "error" || row.severity === "critical"
      ? ui.red(row.severity)
      : row.severity === "warn"
        ? ui.cyan(row.severity)
        : ui.dim(row.severity);
  console.log(`  ${ts} ${sev} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
