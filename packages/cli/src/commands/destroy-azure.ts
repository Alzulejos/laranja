/**
 * `laranja destroy` for Azure.
 *
 * Names are DERIVED from the project + stage (the same helpers the synth package
 * uses), not read from local state — so teardown works from a clean checkout or
 * a different machine.
 *
 * Resources are deleted explicitly rather than via a Complete-mode deployment,
 * which would delete anything else living in the same resource group. The group
 * itself is never touched: laranja deploys into a group it doesn't own.
 */

import {
  azureAppInsightsName,
  azureFunctionAppName,
  azureLogWorkspaceName,
  azurePlanName,
  azureStorageAccountName,
  loadConfig,
  patchDeployment,
  postDestroy,
  resolveApiKey,
} from "@alzulejos/laranja-core";
import {
  azureResourceGroupLocation,
  deleteResourceById,
  deleteRoleAssignmentsForPrincipal,
  functionAppPrincipalId,
  listAzureResourceNames,
  managementToken,
  resourceId,
} from "../azure.js";
import { reportSafely } from "../lifecycle.js";
import { step, note } from "../diagnostics.js";
import { confirm } from "../io.js";
import * as ui from "../ui.js";
import { resolveAzureTarget } from "../managed.js";

export async function destroyAzure(projectDir: string, opts: { stage?: string } = {}): Promise<void> {
  step("load config");
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const target = await resolveAzureTarget(config);

  // Same fail-closed gate as the AWS path: the dashboard call authenticates and
  // authorizes before anything is deleted.
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to destroy.");
  const projectId = config.projectId;
  if (!projectId) {
    throw new Error("This project isn't linked to laranja — run `laranja init` before destroy.");
  }

  const app = config.name;
  const stage = config.stage;
  const site = azureFunctionAppName(app, stage);
  const plan = azurePlanName(app, stage);
  const insights = azureAppInsightsName(app, stage);
  const workspace = azureLogWorkspaceName(app, stage);
  const storage = azureStorageAccountName(app, stage);

  note({ project: app, stage, ...target, site });
  ui.header(`destroy ${app} ${ui.dim(stage)} ${ui.dim("→")} azure/${target.resourceGroup}`);
  ui.note(`this will DELETE the function app, plan, storage, insights and logs for "${app}" (${stage}).`);
  ui.note(`the resource group "${target.resourceGroup}" itself is left alone.`);
  if (!(await confirm("     are you sure? (y/N)"))) {
    console.log("\n  aborted.\n");
    return;
  }

  // Report the group's real Azure region (e.g. "westus2"), not the group name —
  // same as deploy. Best-effort with a fallback; a lookup must never block teardown.
  let region = target.resourceGroup;
  try {
    const location = await azureResourceGroupLocation(
      await managementToken(),
      target.subscriptionId,
      target.resourceGroup,
    );
    if (location) region = location;
  } catch {
    // keep the fallback
  }

  step("open teardown");
  const deploymentId = await postDestroy(
    // `stackName` is the wire's name for "what's being torn down"; Azure has no
    // stack, so send the same app-stage identity the resources are named after.
    { stackName: `${app}-${stage}`, artifact: "arm", provider: "AZURE", region },
    apiKey,
    projectId,
  );
  note({ deploymentId });
  await reportSafely("report start", () =>
    patchDeployment(deploymentId, { status: "STARTED", region }, apiKey, projectId),
  );

  // A project deploys one Function App per workload, so discover them from the group
  // rather than deriving from config: that also reclaims a `workers()` root's app after
  // the root is renamed or deleted from the source, which name-derivation would orphan.
  // `site` is the primary app's name and every other is `<site>-<slug>`; the trailing
  // hyphen keeps a sibling project ("shop-development") out of "shop-dev"'s sweep.
  const owns = (name: string): boolean => name === site || name.startsWith(`${site}-`);
  const discovered = await listAzureResourceNames(target, "Microsoft.Web", "sites", "2023-12-01");
  const sites = discovered.filter(owns);
  // Fall back to the derived name when discovery returns nothing (no permission to
  // list, say) so destroy still does its job rather than silently deleting nothing.
  if (sites.length === 0) sites.push(site);
  const plans = (await listAzureResourceNames(target, "Microsoft.Web", "serverfarms", "2023-12-01")).filter(owns);
  if (plans.length === 0) plans.push(plan);

  // Capture each app's principal BEFORE deleting it — the role assignments are
  // named with ARM guids we can't reproduce, so they're found by principal, and
  // the principal is only readable while the app still exists.
  const principalIds = (await Promise.all(sites.map((s) => functionAppPrincipalId(target, s)))).filter(
    (p): p is string => Boolean(p),
  );

  // Order matters: the apps first (they hold the plans and read the storage), then
  // their dependencies. Each returns false if already gone, so a re-run is safe.
  const targets: [string, string, string, string][] = [
    ...sites.map((s): [string, string, string, string] => ["Microsoft.Web", "sites", s, "2023-12-01"]),
    ...plans.map((p): [string, string, string, string] => ["Microsoft.Web", "serverfarms", p, "2023-12-01"]),
    ["Microsoft.Storage", "storageAccounts", storage, "2023-05-01"],
    // App Insights before its workspace: the component references the workspace.
    ["Microsoft.Insights", "components", insights, "2020-02-02"],
    ["Microsoft.OperationalInsights", "workspaces", workspace, "2022-10-01"],
  ];

  const sp = ui.spinner("tearing down");
  const removed: string[] = [];
  try {
    for (const [provider, type, name, apiVersion] of targets) {
      const existed = await deleteResourceById(resourceId(target, provider, type, name), apiVersion);
      if (existed) removed.push(name);
    }
    // Clean up the RBAC grants — deleting the storage account doesn't cascade
    // them, so they'd otherwise linger as orphans referencing a deleted identity.
    // One identity per app, so every app's grants have to be swept.
    for (const principalId of principalIds) {
      const n = await deleteRoleAssignmentsForPrincipal(target, principalId);
      if (n) removed.push(`${n} role assignment(s)`);
    }
    sp.succeed(removed.length ? `destroyed ${removed.length} item(s)` : "nothing to destroy");
  } catch (err) {
    sp.fail("destroy failed");
    await reportSafely("report failure", () =>
      patchDeployment(deploymentId, { status: "FAILED" }, apiKey, projectId),
    );
    throw err;
  }

  await reportSafely("report success", () =>
    patchDeployment(deploymentId, { status: "SUCCESS" }, apiKey, projectId),
  );
  // The deployment container lives inside the storage account, so it goes with it.
  console.log(`\n  ${ui.orange("🧹 gone")}\n`);
}
