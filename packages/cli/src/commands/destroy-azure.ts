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
import { deleteResourceById, resourceId } from "../azure.js";
import { reportSafely } from "../lifecycle.js";
import { step, note } from "../diagnostics.js";
import { confirm } from "../io.js";
import * as ui from "../ui.js";

export async function destroyAzure(projectDir: string, opts: { stage?: string } = {}): Promise<void> {
  step("load config");
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const target = {
    subscriptionId: config.azure!.subscriptionId,
    resourceGroup: config.azure!.resourceGroup,
  };

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

  step("open teardown");
  const deploymentId = await postDestroy(
    // `stackName` is the wire's name for "what's being torn down"; Azure has no
    // stack, so send the same app-stage identity the resources are named after.
    { stackName: `${app}-${stage}`, artifact: "arm", provider: "AZURE", region: target.resourceGroup },
    apiKey,
    projectId,
  );
  note({ deploymentId });
  await reportSafely("report start", () =>
    patchDeployment(deploymentId, { status: "STARTED", region: target.resourceGroup }, apiKey, projectId),
  );

  // Order matters: the app first (it holds the plan and reads the storage), then
  // its dependencies. Each returns false if already gone, so a re-run is safe.
  const targets: [string, string, string, string][] = [
    ["Microsoft.Web", "sites", site, "2023-12-01"],
    ["Microsoft.Web", "serverfarms", plan, "2023-12-01"],
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
    sp.succeed(removed.length ? `destroyed ${removed.length} resource(s)` : "nothing to destroy");
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
