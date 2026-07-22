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

/** One predicted change from ARM what-if, flattened for rendering. */
export interface PlannedChange {
  /** Create | Delete | Modify | Deploy | NoChange | Ignore | Unsupported. */
  changeType: string;
  /** Short resource label (type/name), derived from the resource id. */
  resource: string;
}

/**
 * Preview a deployment via ARM what-if — the read-only equivalent of an apply.
 * Returns the predicted per-resource changes without touching anything.
 */
export async function azureWhatIf(args: {
  target: AzureTarget;
  deploymentName: string;
  template: Record<string, unknown>;
  parameters: Record<string, string>;
}): Promise<PlannedChange[]> {
  const { target, deploymentName, template, parameters } = args;
  const client = new DeploymentsClient(azureCredential(), target.subscriptionId);

  const poller = client.deployments.whatIf(target.resourceGroup, deploymentName, {
    properties: { mode: "Incremental", template, parameters: toArmParameters(parameters) },
  });
  const result = await poller.pollUntilDone();

  const changes = result.changes ?? [];
  return changes.map((c) => ({
    changeType: c.changeType,
    resource: shortResource(c.resourceId ?? c.symbolicName ?? "resource"),
  }));
}

/** "Microsoft.Web/sites/foo" → "sites/foo" from a full resource id. */
function shortResource(resourceId: string): string {
  const i = resourceId.indexOf("/providers/");
  if (i === -1) return resourceId;
  const parts = resourceId.slice(i + "/providers/".length).split("/");
  // [namespace, type, name, (subtype, subname)...] → drop the namespace.
  return parts.slice(1).join("/");
}

/** Acquire an ARM management bearer token. */
export async function managementToken(): Promise<string> {
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


/**
 * A user-assigned identity's principalId, or undefined if it's already gone.
 * Read BEFORE deleting the identity so its role assignments (keyed to this
 * principal) can be cleaned up.
 */
export async function managedIdentityPrincipalId(
  target: AzureTarget,
  identityName: string,
): Promise<string | undefined> {
  const token = await managementToken();
  const id = resourceId(target, "Microsoft.ManagedIdentity", "userAssignedIdentities", identityName);
  const res = await fetch(`https://management.azure.com${id}?api-version=2023-01-31`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { properties?: { principalId?: string } };
  return body.properties?.principalId;
}

/**
 * Delete every role assignment in the resource group granted to `principalId`.
 *
 * Deleting the storage account does NOT reliably cascade its role assignments —
 * they linger as orphans referencing a now-deleted identity. So teardown removes
 * them explicitly, found by principal (the only handle we have, since the names
 * are ARM guids). Returns how many were removed.
 */
export async function deleteRoleAssignmentsForPrincipal(
  target: AzureTarget,
  principalId: string,
): Promise<number> {
  const token = await managementToken();
  const scope = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}`;
  const filter = encodeURIComponent(`principalId eq '${principalId}'`);
  const listUrl =
    `https://management.azure.com${scope}` +
    `/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${filter}`;

  const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return 0;
  const body = (await res.json()) as { value?: { id: string }[] };

  let removed = 0;
  for (const a of body.value ?? []) {
    const del = await fetch(`https://management.azure.com${a.id}?api-version=2022-04-01`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (del.ok) removed++;
  }
  return removed;
}

/** One log row from Application Insights. */
export interface LogRow {
  timestamp: number;
  message: string;
  severity: string;
}

/**
 * The Log Analytics workspace's query id (`customerId` — a GUID), needed to
 * query it. Undefined if the workspace doesn't exist (nothing deployed yet).
 */
export async function logAnalyticsWorkspaceId(
  target: AzureTarget,
  workspaceName: string,
): Promise<string | undefined> {
  const token = await managementToken();
  const id = resourceId(target, "Microsoft.OperationalInsights", "workspaces", workspaceName);
  const res = await fetch(`https://management.azure.com${id}?api-version=2022-10-01`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { properties?: { customerId?: string } };
  return body.properties?.customerId;
}

/**
 * Query the workspace for the app's logs since `sinceMs` ago. Returns rows
 * oldest-first. `afterTimestamp` (ms) filters to events strictly newer than a
 * previous poll — how `--follow` avoids reprinting.
 *
 * `traces` is where console output and the Functions host logs land; unioned
 * with `exceptions` so errors show too.
 */
export async function queryAppLogs(
  workspaceId: string,
  sinceMs: number,
  afterTimestamp?: number,
): Promise<LogRow[]> {
  const token = await azureCredential().getToken("https://api.loganalytics.io/.default");
  if (!token) throw new Error("Could not acquire a Log Analytics token.");

  const floorIso = new Date(afterTimestamp ?? Date.now() - sinceMs).toISOString();
  // Workspace-based App Insights stores telemetry under `App*` tables with
  // PascalCase columns (NOT the classic `traces`/`timestamp`). AppTraces holds
  // console output + Functions host logs; alias the columns to what the parser
  // below reads. Exceptions also surface here at error severity.
  const kql =
    `AppTraces ` +
    `| where TimeGenerated > datetime(${floorIso}) ` +
    `| project timestamp = TimeGenerated, message = Message, severityLevel = SeverityLevel ` +
    `| order by timestamp asc | take 500`;

  const res = await fetch(`https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: kql }),
  });
  if (!res.ok) throw new Error(`Log query failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as {
    tables?: { columns: { name: string }[]; rows: unknown[][] }[];
  };
  const table = body.tables?.[0];
  if (!table) return [];

  const col = (name: string) => table.columns.findIndex((c) => c.name === name);
  const tsIdx = col("timestamp");
  const msgIdx = col("message");
  const sevIdx = col("severityLevel");

  return table.rows.map((r) => ({
    timestamp: new Date(String(r[tsIdx])).getTime(),
    message: String(r[msgIdx] ?? ""),
    severity: severityName(Number(r[sevIdx] ?? 1)),
  }));
}

/** App Insights severityLevel (0–4) → a short label. */
function severityName(level: number): string {
  return ["verbose", "info", "warn", "error", "critical"][level] ?? "info";
}

/** True if a resource-group-scoped resource already exists (a 200 GET). */
export async function azureResourceExists(id: string, apiVersion: string): Promise<boolean> {
  const token = await managementToken();
  const res = await fetch(`https://management.azure.com${id}?api-version=${apiVersion}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
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
