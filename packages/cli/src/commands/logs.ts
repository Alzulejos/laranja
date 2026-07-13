import {
  CloudWatchLogsClient,
  StartLiveTailCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { loadConfig, stackName } from "@alzulejos/laranja-core";
import { note } from "../diagnostics.js";
import { getAccountId, listStackLambdas, type DeployedLambda, type LambdaKind } from "../aws.js";
import { applyAwsEnv, requireRegion } from "../io.js";
import * as ui from "../ui.js";

const EMOJI: Record<LambdaKind, string> = { http: "🌐", cron: "⏰", queue: "📨", lambda: "λ" };

export interface LogsOptions {
  /** Function to tail (matched against short label / function name). */
  name?: string;
  /** Tail every function in the stack, multiplexed. */
  all?: boolean;
  /** Live-follow new events. Default true; `--no-follow` dumps history and exits. */
  follow?: boolean;
  /** Look-back window for the historical dump, e.g. "1h", "30m", "10s". */
  since?: string;
  /** Deployment stage — selects which stack's functions to tail. */
  stage?: string;
}

export async function logs(projectDir: string, opts: LogsOptions = {}): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const region = requireRegion(config.region);
  note({ project: config.name, stage: config.stage, region });
  applyAwsEnv({ region, profile: config.profile });

  const stack = stackName(config.name, config.stage);
  ui.header(`logs ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} ${region}`);

  // The live CloudFormation stack is the source of truth — no local state needed.
  const sp = ui.spinner("finding functions");
  let fns: DeployedLambda[];
  try {
    fns = await listStackLambdas(region, stack);
  } finally {
    sp.stop(); // always clear the spinner, even when discovery throws
  }
  if (fns.length === 0) throw new Error(`Stack "${stack}" has no Lambda functions.`);

  const label = (f: DeployedLambda): string => shortLabel(f.functionName, config.name, config.stage);
  const targets = await chooseTargets(fns, label, opts);
  if (!targets) {
    console.log(`  ${ui.dim("cancelled.")}\n`);
    return;
  }

  const labelOf = new Map(targets.map((t) => [t.logGroupName, label(t)]));
  const client = new CloudWatchLogsClient({ region });

  // `--since` (or `--no-follow`) prints a historical window first.
  if (opts.since || opts.follow === false) {
    await dumpHistory(client, targets, labelOf, parseSince(opts.since ?? "1h"));
    if (opts.follow === false) return;
  }

  const account = await getAccountId(region);
  await liveTail(client, region, account, targets, labelOf);
}

/** Friendly short label for a function: strip the "<app>-" prefix and "-<stage>" suffix. */
export function shortLabel(functionName: string, appName: string, stage: string): string {
  return functionName
    .replace(new RegExp(`^${appName}-`), "")
    .replace(new RegExp(`-${stage}$`), "");
}

/**
 * Functions matching a user-typed query. Exact matches (full function name or
 * short label) win; only if there are none do we fall back to a substring match
 * — otherwise typing "app" would match every function whose app name contains
 * it. Pure — the impure picker lives separately.
 */
export function matchByName(
  fns: DeployedLambda[],
  query: string,
  label: (f: DeployedLambda) => string,
): DeployedLambda[] {
  const exact = fns.filter((f) => f.functionName === query || label(f) === query);
  return exact.length > 0 ? exact : fns.filter((f) => f.functionName.includes(query));
}

/** Resolve which functions to tail: --all, a name match, or an interactive pick. */
async function chooseTargets(
  fns: DeployedLambda[],
  label: (f: DeployedLambda) => string,
  opts: LogsOptions,
): Promise<DeployedLambda[] | undefined> {
  if (opts.all) return fns;

  if (opts.name) {
    const match = matchByName(fns, opts.name, label);
    if (match.length === 0) {
      throw new Error(
        `No function matching "${opts.name}". Available: ${fns.map((f) => label(f)).join(", ")}`,
      );
    }
    return match;
  }

  // No name given: interactive picker (requires a TTY).
  if (!process.stdin.isTTY) {
    throw new Error(
      `Specify a function (e.g. \`laranja logs ${label(fns[0])}\`) or --all. ` +
        `Available: ${fns.map((f) => label(f)).join(", ")}`,
    );
  }
  const choices = [
    ...fns.map((f) => ({ label: `${EMOJI[f.kind]}  ${label(f).padEnd(20)} ${ui.dim(f.functionName)}`, value: [f] })),
    { label: `📚  ${"all functions".padEnd(20)} ${ui.dim(`${fns.length} log groups`)}`, value: fns },
  ];
  return ui.select("select a function to tail", choices);
}

/** Print recent events from the given window, oldest-first, then return. */
async function dumpHistory(
  client: CloudWatchLogsClient,
  targets: DeployedLambda[],
  labelOf: Map<string, string>,
  sinceMs: number,
): Promise<void> {
  const startTime = Date.now() - sinceMs;
  const multi = targets.length > 1;
  type Row = { timestamp: number; message?: string; group: string };
  const rows: Row[] = [];

  for (const t of targets) {
    let nextToken: string | undefined;
    do {
      const res = await client.send(
        new FilterLogEventsCommand({ logGroupName: t.logGroupName, startTime, nextToken }),
      );
      for (const e of res.events ?? []) {
        rows.push({ timestamp: e.timestamp ?? 0, message: e.message, group: t.logGroupName });
      }
      nextToken = res.nextToken;
    } while (nextToken);
  }

  rows.sort((a, b) => a.timestamp - b.timestamp);
  for (const r of rows) printEvent(r.timestamp, r.message, multi ? labelOf.get(r.group) : undefined);
  if (rows.length === 0) console.log(`  ${ui.dim("(no events in window)")}`);
}

/** Stream new events live until the process is interrupted (Ctrl-C). */
async function liveTail(
  client: CloudWatchLogsClient,
  region: string,
  account: string,
  targets: DeployedLambda[],
  labelOf: Map<string, string>,
): Promise<void> {
  const multi = targets.length > 1;
  const identifiers = targets.map((t) => `arn:aws:logs:${region}:${account}:log-group:${t.logGroupName}`);
  // Map back from the ARN identifier the API echoes to our short label.
  const labelByArn = new Map(
    targets.map((t) => [`arn:aws:logs:${region}:${account}:log-group:${t.logGroupName}`, labelOf.get(t.logGroupName)]),
  );

  const res = await client.send(new StartLiveTailCommand({ logGroupIdentifiers: identifiers }));
  console.log(`  ${ui.green("●")} ${ui.dim(`tailing ${targets.length === 1 ? labelOf.get(targets[0].logGroupName) : `${targets.length} functions`} — Ctrl-C to stop`)}\n`);

  const stream = res.responseStream;
  if (!stream) return;
  for await (const event of stream) {
    for (const e of event.sessionUpdate?.sessionResults ?? []) {
      printEvent(e.timestamp ?? 0, e.message, multi ? labelByArn.get(e.logGroupIdentifier ?? "") : undefined);
    }
  }
}

/** Print one log line: dim timestamp, optional function tag, message. */
function printEvent(timestamp: number, message: string | undefined, tag?: string): void {
  const msg = (message ?? "").replace(/\n$/, "");
  if (!msg) return;
  const ts = ui.dim(new Date(timestamp).toISOString().slice(11, 23));
  const prefix = tag ? `${ui.cyan(tag)} ` : "";
  console.log(`  ${ts} ${prefix}${msg}`);
}

/** Parse a duration like "1h" / "30m" / "10s" / "2d" into milliseconds. */
export function parseSince(s: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`Invalid --since "${s}". Use e.g. 30s, 15m, 1h, 2d.`);
  const n = Number(m[1]);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}
