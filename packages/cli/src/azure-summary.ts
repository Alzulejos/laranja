/**
 * IR-derived views of an Azure deploy — what the app HOSTS, for both the human
 * summary and the dashboard inventory.
 *
 * This exists because Azure crons are timer functions configured via app SETTINGS
 * on the one Function App — they are NOT standalone ARM resources. So ARM what-if
 * (`plan`) and the ARM changeset have nothing cron-shaped to show, and a user
 * would otherwise see only "1 function app" with no hint that a schedule is
 * shipping. The truth about crons lives in the IR, so both the printed summary and
 * the reported resources are derived from it, not from the ARM template.
 *
 * Kept free of the Azure SDK (unlike its caller `deploy-azure`) so it stays unit
 * testable.
 */

import {
  AZURE_HTTP_FUNCTION_NAME,
  azureAppInsightsName,
  describeSchedule,
  type DeployedResource,
  type InfraIR,
} from "@alzulejos/laranja-core";
import * as ui from "./ui.js";

/**
 * A Flex Consumption function app's public URL — deterministic from the app name,
 * so it never depends on ARM deployment outputs (whose keys Azure lowercases).
 */
export function azureFunctionUrl(functionApp: string): string {
  return `https://${functionApp}.azurewebsites.net`;
}

/**
 * Print the functions this app will host: the HTTP proxy and every cron with its
 * human-readable schedule. Called by both `plan` and `deploy` so a scheduled job
 * is never invisible just because it isn't its own cloud resource.
 */
export function printAzureFunctions(ir: InfraIR): void {
  const rows: Array<{ name: string; kind: string; detail: string }> = [];
  if (ir.http) {
    const n = ir.http.routes.length;
    rows.push({ name: "http", kind: "HTTP", detail: `${n} route${n === 1 ? "" : "s"}` });
  }
  for (const c of ir.crons) {
    rows.push({ name: c.id, kind: "Cron", detail: describeSchedule(c.schedule) });
  }
  for (const q of ir.queues) {
    rows.push({ name: q.id, kind: "Queue", detail: `Storage Queue "${q.name}"` });
  }
  if (rows.length === 0) return;

  const nameW = Math.max(...rows.map((r) => r.name.length));
  const kindW = Math.max(...rows.map((r) => r.kind.length));
  console.log(`\n  ${ui.dim("this app hosts:")}`);
  for (const r of rows) {
    console.log(`  ${ui.bold(r.name.padEnd(nameW))}  ${ui.dim(r.kind.padEnd(kindW))}  ${ui.dim(r.detail)}`);
  }
}

/**
 * The dashboard inventory for an Azure deploy: the HTTP proxy plus a `cron` row
 * per scheduled job and a `queue` row per declared queue. All live in ONE Function
 * App, but each is a distinct FUNCTION inside it (the http `api` function, one timer
 * function per cron, one Storage-Queue-triggered function per queue) — so each maps
 * to its own function sub-resource (`…/sites/<app>/functions/<name>`), the handle
 * the portal recognises, rather than the bare app id. The action follows the app
 * (CREATED/UPDATED), and the schedule carries a ready-to-display description,
 * matching the AWS report so the dashboard renders both providers the same way.
 *
 * When `monitoring` is on we also emit the observability node — a `dashboard` row
 * (the SAME type the AWS path uses for its CloudWatch dashboard) whose `externalUrl`
 * deep-links to the App Insights component. Reusing `type: "dashboard"` means the FE
 * renders a clickable monitoring node for Azure without any provider-specific work,
 * which is exactly what the AWS row's contract anticipates. Azure's App Insights
 * overview gives Live Metrics / Logs / Failures out of the box, so there's no
 * laranja-authored dashboard to point at — the component overview is the equivalent.
 */
export function buildAzureResources(args: {
  name: string;
  appName: string;
  stage: string;
  monitoring: boolean;
  target: { subscriptionId: string; resourceGroup: string };
  crons: InfraIR["crons"];
  queues: InfraIR["queues"];
  missingEnv: string[];
  action: "CREATED" | "UPDATED";
}): DeployedResource[] {
  const { name, appName, stage, monitoring, target, crons, queues, missingEnv, action } = args;
  const rgId = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}`;
  const appId = `${rgId}/providers/Microsoft.Web/sites/${name}`;
  // Each function is individually addressable under the app; this is the id that
  // maps a resource row to the specific function it triggers.
  const functionId = (fnName: string) => `${appId}/functions/${fnName}`;

  const resources: DeployedResource[] = [
    {
      // "http" is the logical name the AWS path uses for the proxy; keeping it
      // means the dashboard renders an Azure deploy the same way. The underlying
      // function is `AZURE_HTTP_FUNCTION_NAME` (the shim registers `app.http` with it).
      name: "http",
      type: "http",
      action,
      metadata: missingEnv.length ? { warnings: [`env with no value: ${missingEnv.join(", ")}`] } : {},
      externalId: functionId(AZURE_HTTP_FUNCTION_NAME),
      externalUrl: azureFunctionUrl(name),
    },
  ];

  for (const cron of crons) {
    // The timer function is registered under the cron id (see registerAzureCron).
    resources.push({
      name: cron.id,
      type: "cron",
      action,
      metadata: { schedule: { ...cron.schedule, description: describeSchedule(cron.schedule) } },
      externalId: functionId(cron.id),
      externalUrl: null,
    });
  }

  for (const queue of queues) {
    // The consumer function is registered under the queue name (see registerAzureQueue),
    // so that — not the queue id — is the function sub-resource the portal addresses.
    // `type: "queue"` matches the AWS report so the dashboard's queue→function graph
    // renders identically; fifo is always false (Storage Queues have no FIFO) and there's
    // no per-queue batchSize, so the metadata is intentionally thinner than SQS's.
    resources.push({
      name: queue.id,
      type: "queue",
      action,
      metadata: { queueName: queue.name, fifo: false },
      externalId: functionId(queue.name),
      externalUrl: null,
    });
  }

  // Observability node — mirrors the AWS "monitoring" dashboard row (report.ts).
  if (monitoring) {
    const aiId = `${rgId}/providers/Microsoft.Insights/components/${azureAppInsightsName(appName, stage)}`;
    resources.push({
      name: "monitoring",
      type: "dashboard",
      action,
      metadata: {},
      externalId: aiId,
      externalUrl: `https://portal.azure.com/#@/resource${aiId}/overview`,
    });
  }

  return resources;
}
