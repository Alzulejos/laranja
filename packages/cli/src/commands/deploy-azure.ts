/**
 * `laranja deploy` for Azure.
 *
 * A sibling of the AWS `deploy`, not a branch inside it: almost nothing is
 * shared below the server build. AWS resolves an account, checks a bootstrap and
 * hands a cloud assembly to the CDK toolkit; Azure submits an ARM deployment then
 * publishes the package. What IS shared stays shared — the scan/bundle/synth
 * front half, and the dashboard lifecycle (STARTED before the cloud → outcome).
 *
 * ORDER OF OPERATIONS: provision the infra (ARM), THEN publish the code via one
 * deploy. The template must exist first — it creates the function app that one
 * deploy publishes into. One deploy (not a blob drop) is the only method Flex
 * Consumption honours; see `oneDeployPublish`.
 */

import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  armParamName,
  loadConfig,
  patchDeployment,
  postDeploymentResources,
  resolveApiKey,
  resolveDeclaredEnv,
} from "@alzulejos/laranja-core";
import { buildAzureAssembly } from "../pipeline.js";
import {
  azureResourceExists,
  azureResourceGroupLocation,
  deployTemplate,
  managementToken,
  oneDeployPublish,
  resourceId,
  zipDir,
} from "../azure.js";
import { resolveAzureTarget } from "../managed.js";
import { reportSafely } from "../lifecycle.js";
import { azureFunctionUrl, buildAzureResources, printAzureFunctions } from "../azure-summary.js";
import { step, note } from "../diagnostics.js";
import * as ui from "../ui.js";

export async function deployAzure(
  projectDir: string,
  opts: { verbose?: boolean; stage?: string; strict?: boolean } = {},
): Promise<void> {
  const started = Date.now();

  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to deploy.");
  }

  step("load config");
  const config = await loadConfig(projectDir, { stage: opts.stage });
  // For a managed project this is also what provisions the resource group and
  // installs the server-issued credential — so it happens before any build work,
  // and a quota refusal costs the user nothing.
  const target = await resolveAzureTarget(config);
  note({ project: config.name, stage: config.stage, ...target });

  ui.header(`deploy ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} azure/${target.resourceGroup}`);
  ui.step("🔑", "subscription", target.subscriptionId);

  step("server build (scan/bundle/synth)");
  const built = await buildAzureAssembly(projectDir, { stage: opts.stage }, apiKey);
  const { ir, template, assets, names, warnings, assetDirsById, deploymentId, projectId } = built;
  note({ deploymentId, functionApp: names.functionApp });
  const cronNote = ir.crons.length ? `, ${ir.crons.length} cron${ir.crons.length === 1 ? "" : "s"}` : "";
  const appCount = Object.keys(names.apps ?? { [names.functionApp]: 1 }).length;
  ui.step(
    "📦",
    "server build",
    `${ir.http?.routes.length ?? 0} routes${cronNote} → ${appCount} function app${appCount === 1 ? "" : "s"}`,
  );

  // Crons on Azure are timer functions on the app, not ARM resources — so list
  // them from the IR or they'd be invisible in the (infrastructure-only) output.
  printAzureFunctions(ir);

  // Surface anything the mapping had to change (memory snapped to an instance
  // size, instance count clamped) — silently altering what was asked for is the
  // failure mode worth avoiding.
  for (const w of warnings) ui.warn(w.message);

  // The ARM template inherits its location from the resource group rather than
  // naming a region, so read the group's real location (e.g. "westus2") and
  // report THAT — the dashboard's region field expects an Azure region, not the
  // group name. Best-effort: fall back to the group name if the lookup can't run,
  // and never let it block the deploy.
  let region = target.resourceGroup;
  try {
    const location = await azureResourceGroupLocation(
      await managementToken(),
      target.subscriptionId,
      target.resourceGroup,
    );
    if (location) region = location;
  } catch {
    // keep the fallback; a region lookup must never fail a deploy
  }
  await reportSafely("report start", () =>
    patchDeployment(deploymentId, { status: "STARTED", region }, apiKey, projectId),
  );

  const { resolved, missing } = resolveDeclaredEnv(ir.envKeys);
  const parameters: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) parameters[armParamName(key)] = value;

  if (missing.length && opts.strict) {
    throw new Error(
      `Missing values for env declared in code: ${missing.join(", ")}.\n` +
        `  Set them in your shell / CI (repo secrets) and re-run, or drop --strict.`,
    );
  }

  // One package per workload: the app, plus one per workers() root. `names.apps` maps
  // each asset id to the Function App it publishes to.
  if (assets.length === 0) throw new Error("Internal: server returned no assets for an Azure deploy.");
  const packages = assets.map((asset) => {
    const assetDir = assetDirsById[asset.id];
    if (!assetDir) throw new Error(`Internal: no bundled output for handler "${asset.id}".`);
    const functionApp = names.apps?.[asset.id] ?? names.functionApp;
    if (!functionApp) throw new Error(`Internal: server named no function app for handler "${asset.id}".`);
    return { asset, assetDir, functionApp };
  });

  step("zip packages");
  const azureDir = path.join(projectDir, ".laranja", "azure");
  try {
    for (const p of packages) await zipDir(p.assetDir, path.join(azureDir, p.asset.blobName));

    // Write the template to disk so a failed deploy can be inspected / re-validated
    // with `az deployment group validate --template-file` (the az CLI surfaces the
    // per-resource errors the SDK swallows).
    mkdirSync(azureDir, { recursive: true });
    writeFileSync(path.join(azureDir, "template.json"), JSON.stringify(template, null, 2));
  } catch (err) {
    // STARTED has already been reported; without this the row would orphan at
    // STARTED if packaging throws before the arm deployment step.
    await reportSafely("report failure", () =>
      patchDeployment(deploymentId, { status: "FAILED" }, apiKey, projectId),
    );
    throw err;
  }

  // ARM deployment names are per-group; scoping to app+stage means concurrent
  // stages don't collide, and a redeploy reuses the same name (which is fine —
  // ARM treats it as a new revision).
  const deploymentName = `laranja-${config.name}-${config.stage}`;

  // Whether the function app already exists decides CREATED vs UPDATED in the
  // report — checked BEFORE provisioning, while the answer is still meaningful.
  const alreadyExists = await azureResourceExists(
    resourceId(target, "Microsoft.Web", "sites", names.functionApp),
    "2023-12-01",
  );

  step("arm deployment");
  const sp = ui.spinner("provisioning");
  try {
    // Outputs are ignored — the URL is derived deterministically from the app
    // name (Azure lowercases output keys, so reading them back is unreliable).
    await deployTemplate({ target, deploymentName, template, parameters });
    sp.succeed("provisioned");
  } catch (err) {
    sp.fail("provisioning failed");
    await reportSafely("report failure", () =>
      patchDeployment(deploymentId, { status: "FAILED" }, apiKey, projectId),
    );
    throw err;
  }

  step("publish packages");
  const up = ui.spinner(packages.length === 1 ? "publishing app" : `publishing ${packages.length} apps`);
  // In PARALLEL: the ARM deployment above is one atomic submission, but each app's
  // package is published separately afterwards, and doing them in sequence would make
  // deploy time scale with the number of workers() roots.
  const published = await Promise.allSettled(
    packages.map((p) =>
      // One deploy is the ONLY method Flex Consumption supports — it makes the
      // package the app's ACTIVE deployment (a dropped blob is ignored). On a fresh
      // (or destroy+recreated) app, the identity's storage role may still be
      // propagating — the publish retries through that rather than failing the deploy.
      oneDeployPublish({
        functionApp: p.functionApp,
        zipPath: path.join(azureDir, p.asset.blobName),
        onRetry: ({ attempt, delaySeconds }) =>
          up.update(`waiting for storage permissions to propagate — retry ${attempt} in ${delaySeconds}s`),
      }),
    ),
  );

  const failed = published
    .map((r, i) => ({ r, app: packages[i].functionApp }))
    .filter((x): x is { r: PromiseRejectedResult; app: string } => x.r.status === "rejected");
  if (failed.length > 0) {
    up.fail(`publish failed for ${failed.length} of ${packages.length} app(s)`);
    await reportSafely("report failure", () =>
      patchDeployment(deploymentId, { status: "FAILED" }, apiKey, projectId),
    );
    // Say exactly which apps did and didn't update. A partial publish leaves the
    // project running mixed code versions, and rolling the successes back would be
    // worse than reporting it plainly.
    if (failed.length < packages.length) {
      const ok = packages.map((p) => p.functionApp).filter((a) => !failed.some((f) => f.app === a));
      ui.warn(`updated: ${ok.join(", ")}`);
      ui.warn(`NOT updated (still running previous code): ${failed.map((f) => f.app).join(", ")}`);
    }
    throw failed[0].r.reason;
  }
  up.succeed(`deployed in ${Math.round((Date.now() - started) / 1000)}s`);

  // Only a project with an http() app has a public URL worth printing; a
  // crons/queues-only app has a Function App hostname but nothing serving on it.
  if (ir.http) {
    console.log();
    ui.step("🌐", "http", azureFunctionUrl(names.functionApp));
  }

  step("report success");
  const resources = buildAzureResources({
    name: names.functionApp,
    appName: ir.app.name,
    stage: ir.app.stage,
    monitoring: ir.app.monitoring,
    hasHttp: Boolean(ir.http),
    target,
    ir,
    // So each row links to the app that actually hosts it, not always the primary.
    apps: names.apps ?? { http: names.functionApp },
    missingEnv: missing,
    action: alreadyExists ? "UPDATED" : "CREATED",
  });
  await reportSafely("report success", () =>
    patchDeployment(deploymentId, { status: "SUCCESS" }, apiKey, projectId),
  );
  await reportSafely("report resources", () =>
    postDeploymentResources(deploymentId, { resources }, apiKey, projectId),
  );
  ui.step("📊", "reported", `${resources.length} resource(s) → dashboard`);

  if (missing.length) {
    console.log();
    ui.warn(`deployed without values for: ${missing.join(", ")}`);
    ui.note("these env vars weren't set locally/in CI — set them and re-run deploy to populate them.");
  }

  console.log(`\n  ${ui.orange("✨ live")}\n`);
}
