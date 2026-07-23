/**
 * `laranja eject` for Azure — hand the user an owned, `az`-only infra project.
 *
 * Produces `infra/`:
 *   - main.json        the ARM template (their infrastructure, editable)
 *   - parameters.json  values for the code-discovered env("…") secrets
 *   - package.zip      the already-built code package (snapshot)
 *   - deploy.sh        `az deployment group create` + one-deploy the zip
 *   - README.md
 *
 * Deploying it needs only the Azure CLI + a login — no laranja, no Node, no
 * build step. The tradeoff (stated in the README): the zip is a snapshot, so
 * changing the code means rebuilding the package, which is laranja's job.
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
  type InfraIR,
} from "@alzulejos/laranja-core";
import { buildAzureEjectPackage } from "../pipeline.js";
import { zipDir } from "../azure.js";
import { scan } from "@alzulejos/laranja-scanner";
import { step, note } from "../diagnostics.js";
import * as ui from "../ui.js";

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

  const target = {
    subscriptionId: config.azure!.subscriptionId,
    resourceGroup: config.azure!.resourceGroup,
  };
  const functionApp = azureFunctionAppName(config.name, config.stage);

  // The ARM template is the server's to produce (entitlement-gated). Scan for the
  // IR to send; the paid call happens before the local build so a 403 costs
  // nothing.
  const ir = scan({ projectDir, config });
  step("server eject");
  let res;
  try {
    res = await postEject(
      // A placeholder hash: the ARM template is asset-hash-independent (code ships
      // via one-deploy, not a hash-named blob), but synthAzure requires one.
      { project: ir.app.name, stage: ir.app.stage, artifact: "arm", ir, assets: { http: "ejected" } },
      apiKey,
      config.projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(apiErrorMessage("Eject failed", err));
    throw err;
  }
  const templateFile = res.files.find((f) => f.path.endsWith(".json"));
  if (!templateFile) throw new Error("Server didn't return an ARM template for eject.");

  // Build + zip the code package locally (the bundler is client-side).
  step("build package");
  const { assetDir } = await buildAzureEjectPackage(projectDir, { stage: opts.stage });

  mkdirSync(ejectDir, { recursive: true });
  writeFileSync(path.join(ejectDir, "main.json"), templateFile.contents);
  writeFileSync(path.join(ejectDir, "parameters.json"), buildParameters(ir));
  writeFileSync(path.join(ejectDir, "deploy.sh"), buildDeployScript(target, functionApp), { mode: 0o755 });
  writeFileSync(path.join(ejectDir, "README.md"), buildReadme(target, functionApp, ir));
  await zipDir(assetDir, path.join(ejectDir, "package.zip"));

  const rel = path.relative(projectDir, ejectDir);
  console.log(`\nEjected to ${rel}/ — deploy it with just the Azure CLI:`);
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

/** Self-contained deploy script: provision the infra, then one-deploy the code. */
function buildDeployScript(target: { resourceGroup: string }, functionApp: string): string {
  return `#!/usr/bin/env bash
# Deploy this project with only the Azure CLI. Run: az login (once), then ./deploy.sh
set -euo pipefail

RG="${target.resourceGroup}"
APP="${functionApp}"

echo "→ provisioning infrastructure"
az deployment group create \\
  --resource-group "$RG" \\
  --template-file main.json \\
  --parameters @parameters.json \\
  --output none

echo "→ publishing code (one deploy)"
# Flex Consumption only supports one deploy — the SCM /api/publish endpoint.
TOKEN=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)
curl -sS -X POST "https://$APP.scm.azurewebsites.net/api/publish?type=zip&RemoteBuild=false" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/zip" \\
  --data-binary @package.zip

echo
echo "✅ live: https://$APP.azurewebsites.net"
`;
}

function buildReadme(target: { subscriptionId: string; resourceGroup: string }, functionApp: string, ir: InfraIR): string {
  const envLines = ir.envKeys.length
    ? ir.envKeys.map((k) => `- \`${k}\` → set \`${armParamName(k)}\` in \`parameters.json\``).join("\n")
    : "_None._";
  return `# ${ir.app.name} — ejected Azure infrastructure

This folder is a self-contained copy of your app's Azure infrastructure. You own
it; laranja is no longer involved.

## Deploy

You need only the **Azure CLI** and a login:

\`\`\`bash
az login                 # once
./deploy.sh
\`\`\`

That provisions the infrastructure from \`main.json\` and publishes the code in
\`package.zip\`. Live at \`https://${functionApp}.azurewebsites.net\`.

- **Subscription:** ${target.subscriptionId}
- **Resource group:** ${target.resourceGroup} (must already exist)

## Files

| File | What it is |
|------|-----------|
| \`main.json\` | The ARM template — your infrastructure. Edit freely. |
| \`parameters.json\` | Values for code-discovered \`env("…")\` secrets. |
| \`package.zip\` | Your built code, at eject time. |
| \`deploy.sh\` | Provision + publish, using only \`az\`. |

## Secrets

${envLines}

## Changing your code

\`package.zip\` is a **snapshot** taken at eject time. Editing your app means
rebuilding the package (esbuild bundle + \`@azure/functions\` + \`node_modules\`) —
that build is laranja's job, so for ongoing code changes keep deploying with
\`laranja deploy\`, or set up your own Azure Functions build. The **infrastructure**
here is fully yours to edit and redeploy.

## Prefer Bicep?

\`main.json\` is standard ARM. Convert it to Bicep with one command:

\`\`\`bash
az bicep decompile --file main.json
\`\`\`
`;
}
