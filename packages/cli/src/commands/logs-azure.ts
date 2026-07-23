/**
 * `laranja logs` for Azure — read the app's logs from Application Insights.
 *
 * Azure has no CloudWatch-style live tail; function output lands in Application
 * Insights (the Log Analytics workspace this app created), queried with KQL.
 * `--follow` polls for new events. Note App Insights has an ingestion delay of
 * ~1–2 minutes, so "live" is near-real-time, not instant — surfaced to the user.
 *
 * One Azure Function App hosts MANY functions (the `api` HTTP function + one per
 * cron), so — like the AWS path — you can tail a single function (a name or the
 * interactive picker) or all of them (`--all`), with each line tagged by function.
 */

import {
  azureFunctionAppName,
  azureLogWorkspaceName,
  loadConfig,
} from "@alzulejos/laranja-core";
import {
  listAzureFunctions,
  logAnalyticsWorkspaceId,
  queryAppLogs,
  type AzureTarget,
  type LogRow,
} from "../azure.js";
import { note } from "../diagnostics.js";
import * as ui from "../ui.js";
import type { LogsOptions } from "./logs.js";
import { parseSince } from "./logs.js";

const POLL_MS = 5000;

/** Resolution of which function to tail: a single name, or all (`undefined`). */
type Target = { functionName?: string };

export async function logsAzure(projectDir: string, opts: LogsOptions = {}): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  note({ project: config.name, stage: config.stage });

  ui.header(`logs ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} azure/${config.azure!.resourceGroup}`);

  const target = {
    subscriptionId: config.azure!.subscriptionId,
    resourceGroup: config.azure!.resourceGroup,
  };
  const functionApp = azureFunctionAppName(config.name, config.stage);
  const workspace = azureLogWorkspaceName(config.name, config.stage);

  // Which function to tail — a name, --all, or an interactive pick.
  const picked = await chooseFunction(target, functionApp, opts);
  if (picked === "cancelled") {
    console.log(`  ${ui.dim("cancelled.")}\n`);
    return;
  }
  const { functionName } = picked;
  // When tailing everything, tag each line with its function so they're separable.
  const showFn = functionName === undefined;

  const sp = ui.spinner("finding logs");
  const workspaceId = await logAnalyticsWorkspaceId(target, workspace);
  sp.stop();
  if (!workspaceId) {
    throw new Error(`No Log Analytics workspace for "${config.name}" (${config.stage}) — deploy it first.`);
  }

  const sinceMs = parseSince(opts.since ?? "1h");

  // History window first (always, since there's no instant tail to fall into).
  const history = await queryAppLogs(workspaceId, sinceMs, { functionName });
  for (const row of history) printRow(row, showFn);
  if (history.length === 0) console.log(`  ${ui.dim("(no events in window)")}`);

  if (opts.follow === false) return;

  // Follow: poll for events newer than the last one we printed.
  const scope = functionName ?? "all functions";
  ui.note(`tailing ${scope} — App Insights has a ~1–2 min ingestion delay, so live output isn't instant. Ctrl-C to stop.`);
  let lastSeen = history.length ? history[history.length - 1].timestamp : Date.now() - sinceMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(POLL_MS);
    const rows = await queryAppLogs(workspaceId, sinceMs, { afterTimestamp: lastSeen + 1, functionName });
    for (const row of rows) {
      printRow(row, showFn);
      lastSeen = Math.max(lastSeen, row.timestamp);
    }
  }
}

/**
 * Resolve which function to tail. `--all` (or an app whose functions can't be
 * listed) tails everything; a `name` matches one function; otherwise an
 * interactive picker (with an "all" option) is shown when attached to a TTY, and
 * non-interactive callers default to all.
 */
async function chooseFunction(
  target: AzureTarget,
  functionApp: string,
  opts: LogsOptions,
): Promise<Target | "cancelled"> {
  if (opts.all) return {};

  const fns = await listAzureFunctions(target, functionApp);

  if (opts.name) {
    const q = opts.name.toLowerCase();
    const exact = fns.find((f) => f.toLowerCase() === q);
    if (exact) return { functionName: exact };
    const partial = fns.filter((f) => f.toLowerCase().includes(q));
    if (partial.length === 1) return { functionName: partial[0] };
    // If we couldn't list functions, trust the user's input rather than block.
    if (fns.length === 0) return { functionName: opts.name };
    throw new Error(`No function matching "${opts.name}". Available: ${fns.join(", ")}`);
  }

  // No name: pick interactively when we can; otherwise tail everything.
  if (fns.length <= 1 || !process.stdin.isTTY) {
    return fns.length === 1 ? { functionName: fns[0] } : {};
  }
  const ALL = "\0all";
  const choice = await ui.select<string>("select a function to tail", [
    { label: `📚  ${"all functions".padEnd(20)} ${ui.dim(`${fns.length} functions`)}`, value: ALL },
    ...fns.map((f) => ({ label: f, value: f })),
  ]);
  if (choice === undefined) return "cancelled";
  return choice === ALL ? {} : { functionName: choice };
}

function printRow(row: LogRow, showFn: boolean): void {
  const msg = row.message.replace(/\n$/, "");
  if (!msg) return;
  const ts = ui.dim(new Date(row.timestamp).toISOString().slice(11, 23));
  const sev =
    row.severity === "error" || row.severity === "critical"
      ? ui.red(row.severity)
      : row.severity === "warn"
        ? ui.cyan(row.severity)
        : ui.dim(row.severity);
  const tag = showFn && row.fn ? `${ui.cyan(row.fn)} ` : "";
  console.log(`  ${ts} ${sev} ${tag}${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
