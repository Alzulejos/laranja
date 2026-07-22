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
  type DeployedResource,
} from "@alzulejos/laranja-core";
import { buildAzureAssembly } from "../pipeline.js";
import { deployTemplate, oneDeployPublish, zipDir } from "../azure.js";
import { runPreflight } from "../preflight.js";
import { reportSafely } from "../lifecycle.js";
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
  // loadConfig guarantees both for an azure project, so a miss here is a bug.
  const target = {
    subscriptionId: config.azure!.subscriptionId,
    resourceGroup: config.azure!.resourceGroup,
  };
  note({ project: config.name, stage: config.stage, ...target });

  ui.header(`deploy ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} azure/${target.resourceGroup}`);
  ui.step("🔑", "subscription", target.subscriptionId);

  // Check the environment BEFORE building/synthesizing anything — an
  // unregistered provider, a missing resource group, or absent credentials all
  // fail the deploy mid-flight otherwise, reading as a laranja bug. Abort with the
  // fix list instead of doing work that's doomed.
  step("preflight");
  if (!(await runPreflight(config))) {
    ui.warn("environment isn't ready — fix the items above and re-run.");
    return;
  }

  step("server build (scan/bundle/synth)");
  const built = await buildAzureAssembly(projectDir, { stage: opts.stage }, apiKey);
  const { ir, template, assets, names, warnings, assetDirsById, deploymentId, projectId } = built;
  note({ deploymentId, functionApp: names.functionApp });
  ui.step("📦", "server build", `${ir.http?.routes.length ?? 0} routes → 1 function app`);

  // Surface anything the mapping had to change (memory snapped to an instance
  // size, instance count clamped) — silently altering what was asked for is the
  // failure mode worth avoiding.
  for (const w of warnings) ui.warn(w.message);

  // The region only becomes known here: the template takes its location from the
  // resource group, so the CLI reports the group as the deploy target.
  await reportSafely("report start", () =>
    patchDeployment(deploymentId, { status: "STARTED", region: target.resourceGroup }, apiKey, projectId),
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

  const asset = assets.find((a) => a.id === "http");
  if (!asset) throw new Error("Internal: server returned no http asset for an Azure deploy.");
  const assetDir = assetDirsById[asset.id];
  if (!assetDir) throw new Error(`Internal: no bundled output for handler "${asset.id}".`);

  step("zip package");
  const azureDir = path.join(projectDir, ".laranja", "azure");
  const zipPath = path.join(azureDir, asset.blobName);
  await zipDir(assetDir, zipPath);

  // Write the template to disk so a failed deploy can be inspected / re-validated
  // with `az deployment group validate --template-file` (the az CLI surfaces the
  // per-resource errors the SDK swallows).
  mkdirSync(azureDir, { recursive: true });
  writeFileSync(path.join(azureDir, "template.json"), JSON.stringify(template, null, 2));

  // ARM deployment names are per-group; scoping to app+stage means concurrent
  // stages don't collide, and a redeploy reuses the same name (which is fine —
  // ARM treats it as a new revision).
  const deploymentName = `laranja-${config.name}-${config.stage}`;

  step("arm deployment");
  const sp = ui.spinner("provisioning");
  let outputs: Record<string, string>;
  try {
    outputs = await deployTemplate({ target, deploymentName, template, parameters });
    sp.succeed("provisioned");
  } catch (err) {
    sp.fail("provisioning failed");
    await reportSafely("report failure", () =>
      patchDeployment(deploymentId, { status: "FAILED" }, apiKey, projectId),
    );
    throw err;
  }

  step("publish package");
  const up = ui.spinner("publishing app");
  try {
    // One deploy is the ONLY method Flex Consumption supports — it makes the
    // package the app's ACTIVE deployment (a dropped blob is ignored).
    await oneDeployPublish({ functionApp: names.functionApp, zipPath });
    up.succeed(`deployed in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    up.fail("publish failed");
    await reportSafely("report failure", () =>
      patchDeployment(deploymentId, { status: "FAILED" }, apiKey, projectId),
    );
    throw err;
  }

  console.log();
  if (outputs.HttpUrl) ui.step("🌐", "http", outputs.HttpUrl);

  step("report success");
  const resources = buildAzureResources({
    name: names.functionApp,
    target,
    outputs,
    missingEnv: missing,
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

/**
 * The dashboard inventory for an Azure deploy.
 *
 * Scoped to what v1 creates: one function app serving HTTP. Everything is
 * reported CREATED because there's no prior-state snapshot on this path yet (the
 * AWS equivalent reads it from CloudFormation first) — over-reporting CREATED is
 * more honest than guessing UPDATED.
 */
function buildAzureResources(args: {
  name: string;
  target: { subscriptionId: string; resourceGroup: string };
  outputs: Record<string, string>;
  missingEnv: string[];
}): DeployedResource[] {
  const { name, target, outputs, missingEnv } = args;
  return [
    {
      // "http" is the logical name the AWS path uses for the proxy; keeping it
      // means the dashboard renders an Azure deploy the same way.
      name: "http",
      type: "http",
      action: "CREATED",
      metadata: missingEnv.length ? { warnings: [`env with no value: ${missingEnv.join(", ")}`] } : {},
      // Azure's stable identifier is the full resource id — the ARN analogue.
      externalId:
        `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}` +
        `/providers/Microsoft.Web/sites/${name}`,
      externalUrl: outputs.HttpUrl ?? null,
    },
  ];
}
