/**
 * The Azure deploy executor.
 *
 * The AWS path hands a cloud assembly to the CDK toolkit, which uploads assets
 * and drives CloudFormation. Azure has a direct equivalent, so this uses the SDK
 * rather than shelling out to a binary the user has to install:
 *
 *   1. zip the bundled package
 *   2. upload it to the deployment blob container
 *   3. submit the ARM template as a resource-group deployment
 *   4. read the deployment outputs back
 *
 * Ordering note: the container is created BY the template, but the package must
 * exist BEFORE the function app starts. So the deployment runs first (creating
 * storage + container + app), then the package is uploaded, then the app is
 * restarted to pick it up — see `deployAzure` for why that beats the alternative.
 */

import path from "node:path";
import { createWriteStream, mkdirSync } from "node:fs";
import archiver from "archiver";
import { DefaultAzureCredential } from "@azure/identity";
import { DeploymentsClient } from "@azure/arm-resourcesdeployments";
import { BlobServiceClient } from "@azure/storage-blob";

/** Credential chain: env vars, managed identity, then `az login`. */
export function azureCredential(): DefaultAzureCredential {
  return new DefaultAzureCredential();
}

/**
 * Zip a directory's CONTENTS (not the directory itself) to `dest`.
 *
 * ⚠️ The "not the directory itself" part is load-bearing: if the archive has a
 * parent folder, `host.json` isn't at the zip root and the Functions host
 * detects no functions at all — silently, with no error.
 */
export function zipDir(sourceDir: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(path.dirname(dest), { recursive: true });
    const out = createWriteStream(dest);
    const archive = archiver("zip", { zlib: { level: 9 } });
    out.on("close", () => resolve());
    out.on("error", reject);
    archive.on("error", reject);
    archive.pipe(out);
    // `false` = don't nest under a directory entry.
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

export interface AzureTarget {
  subscriptionId: string;
  resourceGroup: string;
}

/**
 * Submit an ARM template as an incremental resource-group deployment.
 *
 * Incremental (not Complete) is deliberate: Complete mode DELETES anything in
 * the resource group that isn't in the template, which would destroy unrelated
 * resources if a user deploys into a shared group.
 */
export async function deployTemplate(args: {
  target: AzureTarget;
  deploymentName: string;
  template: Record<string, unknown>;
  parameters: Record<string, string>;
}): Promise<Record<string, string>> {
  const { target, deploymentName, template, parameters } = args;
  const client = new DeploymentsClient(azureCredential(), target.subscriptionId);

  const poller = client.deployments.createOrUpdate(target.resourceGroup, deploymentName, {
    properties: { mode: "Incremental", template, parameters: toArmParameters(parameters) },
  });
  const result = await poller.pollUntilDone();

  const outputs = (result.properties?.outputs ?? {}) as Record<string, { value?: unknown }>;
  const flat: Record<string, string> = {};
  for (const [key, entry] of Object.entries(outputs)) {
    if (entry?.value === undefined || entry.value === null) continue;
    flat[key] = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
  }
  return flat;
}

/**
 * Validate a template without deploying it (`az deployment group validate`).
 *
 * This is the check the unit tests can't do — it needs credentials — and it's
 * what actually verifies the hand-written ARM property names against the live
 * schema. Returns an error message, or undefined when the template is valid.
 */
export async function validateTemplate(args: {
  target: AzureTarget;
  deploymentName: string;
  template: Record<string, unknown>;
  parameters: Record<string, string>;
}): Promise<string | undefined> {
  const { target, deploymentName, template, parameters } = args;
  const client = new DeploymentsClient(azureCredential(), target.subscriptionId);
  const poller = client.deployments.validate(target.resourceGroup, deploymentName, {
    properties: { mode: "Incremental", template, parameters: toArmParameters(parameters) },
  });
  const result = await poller.pollUntilDone();
  return result.error ? `${result.error.code}: ${result.error.message}` : undefined;
}

/** ARM wants `{ name: { value } }`, not a flat map. */
function toArmParameters(parameters: Record<string, string>): Record<string, { value: string }> {
  const out: Record<string, { value: string }> = {};
  for (const [key, value] of Object.entries(parameters)) out[key] = { value };
  return out;
}

/**
 * Upload the deployment package to the blob container the function app reads.
 *
 * Uses the caller's own Azure credentials — the app itself reads the blob with
 * its managed identity, so no key or connection string is ever handled here.
 */
export async function uploadPackage(args: {
  storageAccount: string;
  container: string;
  blobName: string;
  zipPath: string;
}): Promise<void> {
  const { storageAccount, container, blobName, zipPath } = args;
  const service = new BlobServiceClient(
    `https://${storageAccount}.blob.core.windows.net`,
    azureCredential(),
  );
  const containerClient = service.getContainerClient(container);
  await containerClient.createIfNotExists();
  await containerClient.getBlockBlobClient(blobName).uploadFile(zipPath);
}

/** Restart the function app so it picks up a newly uploaded package. */
export async function restartFunctionApp(args: {
  target: AzureTarget;
  functionApp: string;
}): Promise<void> {
  const { target, functionApp } = args;
  const credential = azureCredential();
  const token = await credential.getToken("https://management.azure.com/.default");
  if (!token) throw new Error("Could not acquire an Azure management token.");

  const url =
    `https://management.azure.com/subscriptions/${target.subscriptionId}` +
    `/resourceGroups/${target.resourceGroup}/providers/Microsoft.Web/sites/${functionApp}` +
    `/restart?api-version=2023-12-01`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (!res.ok) {
    throw new Error(`Restarting ${functionApp} failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Delete a resource by its full Azure resource id.
 *
 * Resources are deleted EXPLICITLY, by name, rather than by running a
 * Complete-mode deployment with an empty template. Complete mode deletes
 * everything in the resource group that isn't in the template — which would
 * destroy unrelated resources whenever a user deploys into a shared group.
 *
 * Returns false when the resource was already gone (404), so a partial teardown
 * can be re-run safely.
 */
export async function deleteResourceById(id: string, apiVersion: string): Promise<boolean> {
  const token = await azureCredential().getToken("https://management.azure.com/.default");
  if (!token) throw new Error("Could not acquire an Azure management token.");

  const res = await fetch(`https://management.azure.com${id}?api-version=${apiVersion}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Deleting ${id} failed: ${res.status} ${await res.text()}`);
  return true;
}

/** Build a full resource id for a resource-group-scoped resource. */
export function resourceId(
  target: AzureTarget,
  provider: string,
  type: string,
  name: string,
): string {
  return (
    `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}` +
    `/providers/${provider}/${type}/${name}`
  );
}
