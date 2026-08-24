#!/usr/bin/env node
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { init } from "./commands/init.js";
import { logout } from "./commands/logout.js";
import { deploy } from "./commands/deploy.js";
import { plan } from "./commands/plan.js";
import { destroy } from "./commands/destroy.js";
import { eject } from "./commands/eject.js";
import { logs } from "./commands/logs.js";
import { dev, type DevAction } from "./commands/dev.js";
import { beginRun, buildFailureReport, writeFailureReport, sendFailureReport } from "./diagnostics.js";
import * as ui from "./ui.js";

const HELP = `laranja — code-first deploy for Node apps

Usage:
  laranja <command> [project-dir]

Local development:
  dev            Start the services your app declares (Postgres, cache, queues)
  dev status     Reprint the connection table without starting anything
  dev down       Stop the services, keeping the data
  dev reset      Stop the services and DELETE the local data

Deploy:
  init           Scaffold a laranja.config.ts (prompts for + stores your API key)
  plan           Preview what a deploy would change (created/changed/unchanged)
  deploy         Deploy into your own cloud account, using your local credentials
  destroy        Tear down the deployed stack
  logs           Tail logs for a deployed function
  eject          Generate an owned, editable infrastructure project (paid)

Account:
  logout         Remove the stored API key (~/.laranja/auth.json)

Flags:
  --stage, -s <name>  Target a stage, e.g. dev/staging/prod; overrides the config
                      (deploy, plan, destroy, logs, eject)
  --verbose, -v       Show full CDK/CloudFormation output (deploy)
  --strict            Fail if an env("...") declared in code has no value set
                      locally or in CI; default is to deploy and warn (deploy)
  --all               Tail every function at once (logs)
  --no-follow         Print recent history and exit, no live tail (logs)
  --since <dur>       History look-back: 30s, 15m, 1h, 2d; default 1h (logs)

project-dir defaults to the current directory.
`;

/**
 * Pull a `--name <value>` (or alias) flag out of args, returning the value and
 * recording the indices it consumed. Tracking consumed indices lets positional
 * parsing (project-dir, the logs function name) skip a flag's value instead of
 * treating it as a positional. Last occurrence wins.
 */
function flagValue(args: string[], names: string[], consumed: Set<number>): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) {
      value = args[i + 1];
      consumed.add(i);
      consumed.add(i + 1);
    }
  }
  return value;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  // Value-flags first, so their values aren't mistaken for positional args.
  const consumed = new Set<number>();
  const stage = flagValue(rest, ["--stage", "-s"], consumed);
  const since = flagValue(rest, ["--since"], consumed);
  const positionals = rest.filter((a, i) => !a.startsWith("-") && !consumed.has(i));

  const projectDir = path.resolve(positionals[0] ?? ".");
  const verbose = rest.includes("--verbose") || rest.includes("-v");

  beginRun(command ?? "(none)", projectDir);

  switch (command) {
    case "init":
      await init(projectDir);
      break;
    case "logout":
      await logout();
      break;
    case "deploy":
      await deploy(projectDir, {
        verbose,
        stage,
        strict: rest.includes("--strict"),
      });
      break;
    case "plan":
      await plan(projectDir, { stage });
      break;
    case "destroy":
      await destroy(projectDir, { stage });
      break;
    case "logs": {
      // Positionals: an existing directory is the project dir; anything else is
      // the function name. So `logs api`, `logs ./app`, and `logs ./app api` all work.
      let dir = ".";
      let name: string | undefined;
      for (const p of positionals) {
        if (existsSync(p) && statSync(p).isDirectory()) dir = p;
        else name = p;
      }
      await logs(path.resolve(dir), {
        name,
        all: rest.includes("--all"),
        follow: !rest.includes("--no-follow"),
        since,
        stage,
      });
      break;
    }
    case "eject":
      await eject(projectDir, { force: rest.includes("--force"), stage });
      break;
    case "dev": {
      // Positionals: a known action word is the action, anything else the dir —
      // so `dev`, `dev status`, `dev ./app` and `dev status ./app` all work.
      const actions: DevAction[] = ["up", "status", "down", "reset"];
      let dir = ".";
      let action: DevAction = "up";
      for (const p of positionals) {
        if ((actions as string[]).includes(p)) action = p as DevAction;
        else dir = p;
      }
      await dev(path.resolve(dir), action, { stage });
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch(async (err) => {
  const report = buildFailureReport(err);
  const logPath = writeFailureReport(report);
  const sent = await sendFailureReport(report);
  console.error(`\n  ${ui.red(`❌ ${report.reason}`)}`);
  console.error(`  ${ui.dim(`failed at step: ${report.step}`)}`);
  if (logPath) console.error(`  ${ui.dim(`report logged to ${logPath}`)}`);
  if (sent) console.error(`  ${ui.dim("report sent to dashboard")}`);
  console.error(`  ${ui.dim("re-run with --verbose for full output")}\n`);
  process.exitCode = 1;
});
