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
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import archiver from "archiver";
import { DefaultAzureCredential } from "@azure/identity";
import { DeploymentsClient } from "@azure/arm-resourcesdeployments";

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

  let result;
  try {
    const poller = client.deployments.createOrUpdate(target.resourceGroup, deploymentName, {
      properties: { mode: "Incremental", template, parameters: toArmParameters(parameters) },
    });
    result = await poller.pollUntilDone();
  } catch (err) {
    // The SDK collapses ARM's per-resource failures into a single "multiple
    // errors" string and drops the response body — so a user sees a generic
    // failure and blames laranja. Re-run the same request through the VALIDATE
    // endpoint with a raw fetch, where we control the response and can read the
    // nested `error.details` (region ineligibility, quota, bad property, …) that
    // actually explains it.
    const detail = await explainArmFailure({ target, deploymentName, template, parameters });
    throw new Error(detail ? `Azure rejected the deployment:\n${detail}` : flattenArmError(err));
  }

  const outputs = (result.properties?.outputs ?? {}) as Record<string, { value?: unknown }>;
  const flat: Record<string, string> = {};
  for (const [key, entry] of Object.entries(outputs)) {
    if (entry?.value === undefined || entry.value === null) continue;
    flat[key] = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
  }
  return flat;
}

/** Acquire an ARM management bearer token. */
async function managementToken(): Promise<string> {
  const token = await azureCredential().getToken("https://management.azure.com/.default");
  if (!token) throw new Error("Could not acquire an Azure management token.");
  return token.token;
}

/**
 * Ask ARM to VALIDATE the template via a raw REST call and return a readable,
 * flattened explanation of why it was rejected — or undefined if validation
 * unexpectedly passed (the deploy failed for some other reason).
 *
 * Done with fetch rather than the SDK precisely because the SDK discards the
 * response body that holds the real reason.
 */
async function explainArmFailure(args: {
  target: AzureTarget;
  deploymentName: string;
  template: Record<string, unknown>;
  parameters: Record<string, string>;
}): Promise<string | undefined> {
  const { target, deploymentName, template, parameters } = args;
  try {
    const token = await managementToken();
    const url =
      `https://management.azure.com/subscriptions/${target.subscriptionId}` +
      `/resourceGroups/${target.resourceGroup}` +
      `/providers/Microsoft.Resources/deployments/${deploymentName}/validate` +
      `?api-version=2021-04-01`;

    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: { mode: "Incremental", template, parameters: toArmParameters(parameters) },
      }),
    });
    if (res.ok) return undefined; // validation passed — not the cause
    const body = (await res.json()) as { error?: unknown };
    const flat = body.error ? flattenArmError(body.error) : "";
    return flat || undefined;
  } catch {
    // Network/token trouble here must not mask the original deploy failure.
    return undefined;
  }
}

/**
 * Validate a template without deploying it. Returns a readable error, or
 * undefined when the template is valid. Exposed for a future `laranja plan`.
 */
export async function validateTemplate(args: {
  target: AzureTarget;
  deploymentName: string;
  template: Record<string, unknown>;
  parameters: Record<string, string>;
}): Promise<string | undefined> {
  return explainArmFailure(args);
}

/**
 * Walk an ARM error's nested `details` tree and return every code+message on its
 * own line. ARM buries per-resource validation failures arbitrarily deep, and
 * the SDK only surfaces the top "multiple errors" summary.
 */
function flattenArmError(err: unknown): string {
  const leaves: string[] = [];

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const e = node as {
      error?: unknown;
      code?: string;
      message?: string;
      target?: string;
      details?: unknown[];
    };
    if (e.error) walk(e.error);
    const kids = e.details ?? [];
    if (kids.length) {
      // Only leaves carry the actionable message; parents are just "multiple
      // errors" summaries, so don't repeat them.
      for (const d of kids) walk(d);
    } else if (e.code || e.message) {
      const where = e.target ? ` [${e.target}]` : "";
      leaves.push(`  • ${e.code ?? "Error"}${where}: ${e.message ?? ""}`.trimEnd());
    }
  };

  walk(err);
  // De-dupe identical lines (ARM repeats the same region error per resource is
  // useful, but exact dupes aren't).
  return [...new Set(leaves)].join("\n");
}

/** ARM wants `{ name: { value } }`, not a flat map. */
function toArmParameters(parameters: Record<string, string>): Record<string, { value: string }> {
  const out: Record<string, { value: string }> = {};
  for (const [key, value] of Object.entries(parameters)) out[key] = { value };
  return out;
}

/**
 * Publish the package via ONE DEPLOY — the only deployment method Flex
 * Consumption supports.
 *
 * Flex Consumption does NOT pick code up from a blob you drop in the container:
 * the platform tracks an ACTIVE package, set only through the SCM `/api/publish`
 * endpoint. Uploading a blob + restarting leaves the app with no functions (the
 * "up and running" default page). One deploy also has the PLATFORM move the
 * package into storage with its own identity, so the deployer needs no
 * blob-data-plane role — just SCM access, which `Contributor` grants.
 *
 * `RemoteBuild=false`: we already bundled + shipped node_modules, so there's
 * nothing for Oryx to build.
 */
export async function oneDeployPublish(args: {
  functionApp: string;
  zipPath: string;
}): Promise<void> {
  const { functionApp, zipPath } = args;
  const token = await managementToken();
  const zip = readFileSync(zipPath);

  const url = `https://${functionApp}.scm.azurewebsites.net/api/publish?type=zip&RemoteBuild=false`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
    body: zip,
  });

  // Async deploy → 202 + a Location to poll. Kudu recycles fast, so poll ~1s.
  if (res.status === 202) {
    const location = res.headers.get("location");
    if (location) await pollKuduDeployment(location, token);
    return;
  }
  if (!res.ok) {
    throw new Error(`Package publish failed: ${res.status} ${await res.text()}`);
  }
}

/** Poll a Kudu deployment status URL until it completes; throw on failure. */
async function pollKuduDeployment(location: string, token: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const res = await fetch(location, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const body = (await res.json()) as { complete?: boolean; status?: number; status_text?: string };
      if (body.complete) {
        // Kudu status: 4 = success, 3 = failed.
        if (body.status === 3) throw new Error(`Package publish failed: ${body.status_text ?? "deployment error"}`);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Package publish timed out waiting for Kudu to finish.");
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
