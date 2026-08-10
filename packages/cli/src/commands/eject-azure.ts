/**
 * `laranja eject` for Azure — hand the user an owned, `az`-only infra project.
 *
 * Produces `infra/`:
 *   - main.json        the ARM template (their infrastructure, editable)
 *   - parameters.json  values for the code-discovered env("…") secrets
 *   - package*.zip     the already-built code packages (snapshots), ONE PER
 *                      workload — an Azure project is one Function App per
 *                      workload (the http() app, plus each workers() root)
 *   - deploy.sh        `az deployment group create` + one-deploy each zip
 *   - README.md
 *
 * Deploying it needs only the Azure CLI + a login — no laranja, no Node, no
 * build step. The tradeoff (stated in the README): the zips are a snapshot, so
 * changing the code means rebuilding them, which is laranja's job.
 *
 * The ARM template comes from the server (`/eject`, entitlement-gated); the
 * config-specific files (deploy.sh, parameters) are written here since only the
 * client knows the subscription / resource group.
 */

import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  armParamName,
  loadConfig,
  resolveApiKey,
  postEject,
  ApiRequestError,
  apiErrorMessage,
  azureFunctionAppName,
  azureWorkloads,
  type AzureWorkload,
  type InfraIR,
  resolveDeployTarget,
} from "@alzulejos/laranja-core";
import { buildAzureEjectPackages } from "../pipeline.js";
import { zipDir } from "../azure.js";
import { scan } from "@alzulejos/laranja-scanner";
import { step, note } from "../diagnostics.js";
import * as ui from "../ui.js";

/**
 * One ejected Function App: which app to publish to, and which zip holds its code.
 * `http` drives which URL the script reports as the live one.
 */
export interface EjectedApp {
  id: string;
  appName: string;
  zip: string;
  http: boolean;
}

/**
 * The apps this project ejects as. Mirrors the server's grouping exactly
 * (`azureWorkloads` is the same function `synthAzure` names its apps from), so the
 * script publishes to the apps the template actually creates.
 */
export function ejectedApps(name: string, stage: string, workloads: AzureWorkload[]): EjectedApp[] {
  return workloads.map((w) => ({
    id: w.id,
    appName: azureFunctionAppName(name, stage, w.suffix),
    // The primary workload keeps the familiar `package.zip`; roots get their own.
    zip: w.suffix ? `package-${w.suffix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.zip` : "package.zip",
    http: w.http,
  }));
}

export async function ejectAzure(projectDir: string, opts: { force?: boolean; stage?: string }): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  note({ project: config.name, stage: config.stage });
  if (!config.projectId) {
    throw new Error('Set "projectId" in laranja.config.ts (from your dashboard) to eject.');
  }
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to eject.");

  const ejectDir = path.join(projectDir, "infra");
  if (existsSync(ejectDir) && !opts.force) {
    throw new Error(`${path.relative(projectDir, ejectDir)}/ already exists. Re-run with --force to overwrite.`);
  }

  // Eject deliberately does NOT resolve a managed target: the point of ejecting
  // is to walk away with something you own, so the generated script names YOUR
  // subscription and group, never laranja's. Managed projects get placeholders
  // to fill in — and no server-side provisioning is triggered by ejecting.
  const managed = resolveDeployTarget(config.provider).managed;
  const target = managed
    ? {
        subscriptionId: "<your-subscription-id>",
        resourceGroup: "<your-resource-group>",
      }
    : {
        subscriptionId: config.azure!.subscriptionId,
        resourceGroup: config.azure!.resourceGroup,
      };
  // The ARM template is the server's to produce (entitlement-gated). Scan for the
  // IR to send; the paid call happens before the local build so a 403 costs
  // nothing.
  const ir = scan({ projectDir, config });
  const apps = ejectedApps(config.name, config.stage, azureWorkloads(ir));
  if (apps.length === 0) {
    throw new Error("Nothing to eject — this project declares no http() app, crons, or queues.");
  }

  step("server eject");
  let res;
  try {
    res = await postEject(
      {
        project: ir.app.name,
        stage: ir.app.stage,
        artifact: "arm",
        ir,
        // Placeholder hashes: the ARM template is asset-hash-independent (code ships
        // via one-deploy, not a hash-named blob), but synthAzure requires one PER
        // workload. Real hashes would mean building before this paid call.
        assets: Object.fromEntries(apps.map((a) => [a.id, "ejected"])),
      },
      apiKey,
      config.projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(apiErrorMessage("Eject failed", err));
    throw err;
  }
  const templateFile = res.files.find((f) => f.path.endsWith(".json"));
  if (!templateFile) throw new Error("Server didn't return an ARM template for eject.");

  // Build + zip the code packages locally (the bundler is client-side).
  step("build packages");
  const { assetDirsById } = await buildAzureEjectPackages(projectDir, { stage: opts.stage });

  mkdirSync(ejectDir, { recursive: true });
  writeFileSync(path.join(ejectDir, "main.json"), templateFile.contents);
  writeFileSync(path.join(ejectDir, "parameters.json"), buildParameters(ir));
  writeFileSync(path.join(ejectDir, "deploy.sh"), buildDeployScript(target, apps), { mode: 0o755 });
  writeFileSync(path.join(ejectDir, "README.md"), buildReadme(target, apps, ir));
  for (const app of apps) {
    const assetDir = assetDirsById[app.id];
    if (!assetDir) throw new Error(`Internal: no bundle built for workload "${app.id}".`);
    await zipDir(assetDir, path.join(ejectDir, app.zip));
  }

  const rel = path.relative(projectDir, ejectDir);
  console.log(`\nEjected to ${rel}/ — deploy it with just the Azure CLI:`);
  if (apps.length > 1) {
    ui.note(`${apps.length} function apps, one package each:`);
    for (const a of apps) console.log(`    ${a.appName}  ←  ${a.zip}`);
  }
  console.log(`  cd ${rel}`);
  console.log("  ./deploy.sh");
}

/** ARM parameter file for the code-discovered env("…") secrets. */
function buildParameters(ir: InfraIR): string {
  const parameters: Record<string, { value: string }> = {};
  for (const key of ir.envKeys) parameters[armParamName(key)] = { value: "" };
  return `${JSON.stringify(
    {
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
      contentVersion: "1.0.0.0",
      parameters,
    },
    null,
    2,
  )}\n`;
}

/** Self-contained deploy script: provision the infra, then one-deploy each package. */
export function buildDeployScript(target: { resourceGroup: string }, apps: EjectedApp[]): string {
  // "<app>:<zip>" pairs — one per Function App the template creates. Each app has
  // its OWN package, so every one needs its own publish call.
  const pairs = apps.map((a) => `  "${a.appName}:${a.zip}"`).join("\n");
  const httpApp = apps.find((a) => a.http);
  const live = httpApp
    ? `echo "✅ live: https://${httpApp.appName}.azurewebsites.net"`
    : `echo "✅ published (no http app — crons/queues only)"`;

  return `#!/usr/bin/env bash
# Deploy this project with only the Azure CLI. Run: az login (once), then ./deploy.sh
set -euo pipefail

RG="${target.resourceGroup}"

# Each Function App and the package that belongs to it.
APPS=(
${pairs}
)

echo "→ provisioning infrastructure"
az deployment group create \\
  --resource-group "$RG" \\
  --template-file main.json \\
  --parameters @parameters.json \\
  --output none

# Flex Consumption only supports one deploy — the SCM /api/publish endpoint.
TOKEN=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)
for entry in "\${APPS[@]}"; do
  APP="\${entry%%:*}"
  ZIP="\${entry#*:}"
  echo "→ publishing $ZIP → $APP"
  curl -sS -X POST "https://$APP.scm.azurewebsites.net/api/publish?type=zip&RemoteBuild=false" \\
    -H "Authorization: Bearer $TOKEN" \\
    -H "Content-Type: application/zip" \\
    --data-binary @"$ZIP"
  echo
done

${live}
`;
}

function buildReadme(
  target: { subscriptionId: string; resourceGroup: string },
  apps: EjectedApp[],
  ir: InfraIR,
): string {
  const envLines = ir.envKeys.length
    ? ir.envKeys.map((k) => `- \`${k}\` → set \`${armParamName(k)}\` in \`parameters.json\``).join("\n")
    : "_None._";
  const httpApp = apps.find((a) => a.http);
  const liveLine = httpApp
    ? `Live at \`https://${httpApp.appName}.azurewebsites.net\`.`
    : `This project has no \`http()\` app — its functions are crons/queues, with no public endpoint.`;
  const appRows = apps
    .map((a) => `| \`${a.appName}\` | ${a.http ? "HTTP app + non-DI handlers" : `\`workers()\` root \`${a.id}\``} | \`${a.zip}\` |`)
    .join("\n");
  const packageRows = apps.map((a) => `| \`${a.zip}\` | Built code for \`${a.appName}\`, at eject time. |`).join("\n");

  return `# ${ir.app.name} — ejected Azure infrastructure

This folder is a self-contained copy of your app's Azure infrastructure. You own
it; laranja is no longer involved.

## Deploy

You need only the **Azure CLI** and a login:

\`\`\`bash
az login                 # once
./deploy.sh
\`\`\`

That provisions the infrastructure from \`main.json\` and publishes each package to
its Function App. ${liveLine}

- **Subscription:** ${target.subscriptionId}
- **Resource group:** ${target.resourceGroup} (must already exist)

## Function apps

Azure runs one Function App **per workload** — your \`http()\` app, plus one for each
\`workers()\` dependency-injection root, so each can have its own memory and scale.
Every app has its own package, and \`deploy.sh\` publishes them all:

| Function App | Hosts | Package |
|---|---|---|
${appRows}

## Files

| File | What it is |
|------|-----------|
| \`main.json\` | The ARM template — your infrastructure. Edit freely. |
| \`parameters.json\` | Values for code-discovered \`env("…")\` secrets. |
${packageRows}
| \`deploy.sh\` | Provision + publish every app, using only \`az\`. |

## Secrets

${envLines}

## Changing your code

The \`.zip\` packages are a **snapshot** taken at eject time. Editing your app means
rebuilding them (esbuild bundle + \`@azure/functions\` + \`node_modules\`) — that build
is laranja's job, so for ongoing code changes keep deploying with
\`laranja deploy\`, or set up your own Azure Functions build. The **infrastructure**
here is fully yours to edit and redeploy.

## Prefer Bicep?

\`main.json\` is standard ARM. Convert it to Bicep with one command:

\`\`\`bash
az bicep decompile --file main.json
\`\`\`
`;
}
