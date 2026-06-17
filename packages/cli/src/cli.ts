#!/usr/bin/env node
import path from "node:path";
import { init } from "./commands/init.js";
import { synthCommand } from "./commands/synth.js";
import { deploy } from "./commands/deploy.js";
import { diff } from "./commands/diff.js";
import { destroy } from "./commands/destroy.js";
import { eject } from "./commands/eject.js";
import * as ui from "./ui.js";

const HELP = `laranja — code-first deploy for Node apps

Usage:
  laranja <command> [project-dir]

Commands:
  init       Scaffold a laranja.config.ts
  synth      Build + show the planned AWS resources (no AWS calls)
  deploy     Deploy into your AWS account (uses local credentials)
  diff       Diff the plan against what's deployed
  destroy    Tear down the deployed stack
  eject      Generate an owned, editable CDK project (paid)

Flags:
  --verbose, -v   Show full CDK/CloudFormation output (deploy/destroy)

project-dir defaults to the current directory.
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const projectDir = path.resolve(rest.find((a) => !a.startsWith("-")) ?? ".");
  const verbose = rest.includes("--verbose") || rest.includes("-v");

  switch (command) {
    case "init":
      init(projectDir);
      break;
    case "synth":
      await synthCommand(projectDir);
      break;
    case "deploy":
      await deploy(projectDir, { verbose });
      break;
    case "diff":
      await diff(projectDir);
      break;
    case "destroy":
      await destroy(projectDir, { verbose });
      break;
    case "eject":
      await eject(projectDir, { force: rest.includes("--force") });
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
