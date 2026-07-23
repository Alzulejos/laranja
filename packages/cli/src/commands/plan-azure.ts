/**
 * `laranja plan` for Azure — preview a deploy via ARM what-if.
 *
 * Read-only: the server produces the ARM template through `/diff` (no deployment
 * row, no quota), and the CLI runs it through ARM what-if against the live
 * resource group. Nothing is created, uploaded, or changed.
 *
 * Note what-if previews the INFRASTRUCTURE (the ARM template) only. The function
 * CODE is published separately via one deploy, so "no infra changes" doesn't mean
 * "no code changes" — a code-only edit shows as NoChange here yet still ships new
 * code on deploy. Called out in the summary so it isn't misread.
 */

import {
  armParamName,
  loadConfig,
  resolveApiKey,
  resolveDeclaredEnv,
} from "@alzulejos/laranja-core";
import { buildAzurePlanTemplate } from "../pipeline.js";
import { azureWhatIf, type PlannedChange } from "../azure.js";
import { printAzureFunctions } from "../azure-summary.js";
import { step, note } from "../diagnostics.js";
import * as ui from "../ui.js";

/** What-if change types that represent an actual change (vs no-op). */
const CHANGED = new Set(["Create", "Delete", "Modify", "Deploy"]);

export async function planAzure(projectDir: string, opts: { stage?: string } = {}): Promise<void> {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to plan.");

  step("load config");
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const target = {
    subscriptionId: config.azure!.subscriptionId,
    resourceGroup: config.azure!.resourceGroup,
  };
  note({ project: config.name, stage: config.stage, ...target });

  ui.header(`plan ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} azure/${target.resourceGroup}`);

  step("server build (scan/diff)");
  const { ir, template } = await buildAzurePlanTemplate(projectDir, { stage: opts.stage }, apiKey);

  // Crons on Azure are app settings on the function app, not ARM resources, so
  // what-if below can't name them — list the app's functions from the IR first.
  printAzureFunctions(ir);

  // Same env resolution as deploy — what-if needs the parameters to diff an
  // accurate picture (an unset secret would otherwise read as a change).
  const { resolved } = resolveDeclaredEnv(ir.envKeys);
  const parameters: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) parameters[armParamName(key)] = value;

  step("what-if");
  const sp = ui.spinner("previewing");
  let changes: PlannedChange[];
  try {
    changes = await azureWhatIf({
      target,
      deploymentName: `laranja-${config.name}-${config.stage}`,
      template,
      parameters,
    });
    sp.stop();
  } catch (err) {
    sp.fail("what-if failed");
    throw err;
  }

  renderChanges(changes);
}

function renderChanges(changes: PlannedChange[]): void {
  const changed = changes.filter((c) => CHANGED.has(c.changeType));

  console.log();
  if (changed.length === 0) {
    console.log(`  ${ui.green("✓")} no infrastructure changes.`);
  } else {
    for (const c of changed) {
      console.log(`  ${symbol(c.changeType)} ${ui.dim(c.changeType.toLowerCase().padEnd(6))} ${c.resource}`);
    }
    const created = changed.filter((c) => c.changeType === "Create").length;
    const modified = changed.filter((c) => c.changeType === "Modify" || c.changeType === "Deploy").length;
    const deleted = changed.filter((c) => c.changeType === "Delete").length;
    console.log();
    console.log(`  ${ui.bold(`${created} to create, ${modified} to change, ${deleted} to delete`)}`);
  }

  // Code isn't part of the ARM template, so what-if can't see a code-only change.
  console.log();
  ui.note("what-if previews infrastructure only — `deploy` always publishes your latest code.");
  console.log();
}

function symbol(changeType: string): string {
  switch (changeType) {
    case "Create":
      return ui.green("+");
    case "Delete":
      return ui.red("-");
    default:
      return ui.cyan("~");
  }
}
