#!/usr/bin/env node
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { init } from "./commands/init.js";
import { logout } from "./commands/logout.js";
import { synthCommand } from "./commands/synth.js";
import { deploy } from "./commands/deploy.js";
import { diff } from "./commands/diff.js";
import { destroy } from "./commands/destroy.js";
import { eject } from "./commands/eject.js";
import { logs } from "./commands/logs.js";
import * as ui from "./ui.js";

const HELP = `laranja — code-first deploy for Node apps

Usage:
  laranja <command> [project-dir]

Commands:
  init       Scaffold a laranja.config.ts (prompts for + stores your API key)
  logout     Remove the stored API key (~/.laranja/auth.json)
  synth      Build + show the planned AWS resources (no AWS calls)
  deploy     Deploy into your AWS account (uses local credentials)
  diff       Diff the plan against what's deployed
  destroy    Tear down the deployed stack
  logs       Tail CloudWatch logs for a deployed function
  eject      Generate an owned, editable CDK project (paid)

Flags:
  --stage, -s <name>  Deployment stage to target, e.g. dev/staging/prod
                      (overrides config; deploy/synth/diff/destroy/logs/eject)
  --verbose, -v       Show full CDK/CloudFormation output (deploy/destroy)
  --strict            deploy: fail if any env("...") declared in code has no
                      value set locally/in CI (default: deploy + warn)
  --remote            synth/deploy: build on the laranja server instead of
                      locally (deploy still applies with YOUR AWS credentials)
  --all               logs: tail every function (multiplexed)
  --no-follow         logs: print recent history and exit (no live tail)
  --since <dur>       logs: history look-back, e.g. 30s, 15m, 1h, 2d (default 1h)

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

  switch (command) {
    case "init":
      await init(projectDir);
      break;
    case "logout":
      await logout();
      break;
    case "synth":
      await synthCommand(projectDir, { remote: rest.includes("--remote"), stage });
      break;
    case "deploy":
      await deploy(projectDir, {
        verbose,
        stage,
        strict: rest.includes("--strict"),
        remote: rest.includes("--remote"),
      });
      break;
    case "diff":
      await diff(projectDir, { stage });
      break;
    case "destroy":
      await destroy(projectDir, { verbose, stage });
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

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${ui.red(`❌ ${message}`)}\n`);
  console.error(`  ${ui.dim("re-run with --verbose for full output")}\n`);
  process.exitCode = 1;
});
