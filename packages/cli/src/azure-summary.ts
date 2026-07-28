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
  azureMaxDequeueCount,
  azurePoisonBindings,
  azurePoisonQueueName,
  azureWorkloads,
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
  // Dead-lettering is invisible in the ARM diff (the poison queue is host behaviour
  // plus an app setting), so the summary says where failures go and via which queue.
  const wiredDlq = new Map(azurePoisonBindings(ir.queues).bindings.map((b) => [b.source, b.dlq]));
  for (const q of ir.queues) {
    const dlq = wiredDlq.get(q.name);
    const detail =
      dlq === undefined
        ? `Storage Queue "${q.name}"`
        : `Storage Queue "${q.name}" · dlq → ${dlq} via "${azurePoisonQueueName(q.name)}"`;
    rows.push({ name: q.id, kind: "Queue", detail });
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
  /** Whether the app has an http() proxy — false for a crons/queues-only Azure app. */
  hasHttp: boolean;
  target: { subscriptionId: string; resourceGroup: string };
  ir: InfraIR;
  /**
   * Each workload's Function App, keyed by workload id (the server's `names.apps`).
   * REQUIRED for correct links: a project deploys one app per workload, so a cron in a
   * `workers()` root is addressable only under ITS app — hanging every function off the
   * primary app produces portal links to functions that don't exist there.
   */
  apps: Record<string, string>;
  missingEnv: string[];
  action: "CREATED" | "UPDATED";
}): DeployedResource[] {
  const { name, appName, stage, monitoring, hasHttp, target, ir, apps, missingEnv, action } = args;
  const rgId = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}`;
  // Each function is individually addressable under the app HOSTING it; this is the id
  // that maps a resource row to the specific function it triggers.
  const functionId = (host: string, fnName: string) =>
    `${rgId}/providers/Microsoft.Web/sites/${host}/functions/${fnName}`;

  const cronById = new Map(ir.crons.map((c) => [c.id, c]));
  const queueByName = new Map(ir.queues.map((q) => [q.name, q]));

  // Dead-lettering, reported exactly like AWS's (`metadata.dlq.queue` = the TARGET
  // queue's resource id) so the dashboard draws the same redrive edge for both
  // providers with no provider-specific FE work. What differs is the mechanism, and
  // that's what `poisonQueue` carries: Azure's dead-letter destination isn't
  // configurable — the host moves failures to `<queue>-poison` and laranja binds an
  // extra trigger there that drains into the declared DLQ's consumer. Naming it means
  // a user who goes looking in the portal finds the queue their messages are in.
  const poison = azurePoisonBindings(ir.queues);
  const dlqBySource = new Map(poison.bindings.map((b) => [b.source, b.dlq]));
  // A DLQ named by 2+ sources is deliberately left UNWIRED by the synth (see
  // `azurePoisonBindings`). Those queues get no redrive edge — they'd claim a delivery
  // that doesn't happen — and carry a warning instead, so the gap is visible in the
  // dashboard rather than only in the deploy log the user has already scrolled past.
  const unwired = new Map(
    poison.conflicts.flatMap((c) => c.sources.map((s) => [s, c.dlq] as const)),
  );

  const resources: DeployedResource[] = [];
  // Walk workloads so every row carries the app that actually runs it. `functionApp`
  // in the metadata is what lets the dashboard GROUP rows by app — the resources stay
  // per-function (a cron with its schedule is the unit the user declared), but they're
  // now attributable to a host.
  for (const w of azureWorkloads(ir)) {
    const host = apps[w.id] ?? name;

    if (w.http && hasHttp) {
      // "http" is the logical name the AWS path uses for the proxy; keeping it means
      // the dashboard renders an Azure deploy the same way. The underlying function is
      // `AZURE_HTTP_FUNCTION_NAME` (the shim registers `app.http` with it). Absent for
      // a crons/queues-only app, which has no http function.
      resources.push({
        name: "http",
        type: "http",
        action,
        metadata: { functionApp: host },
        externalId: functionId(host, AZURE_HTTP_FUNCTION_NAME),
        externalUrl: azureFunctionUrl(host),
      });
    }

    for (const id of w.cronIds) {
      const cron = cronById.get(id);
      if (!cron) continue;
      // The timer function is registered under the cron id (see registerAzureCron).
      resources.push({
        name: cron.id,
        type: "cron",
        action,
        metadata: {
          schedule: { ...cron.schedule, description: describeSchedule(cron.schedule) },
          functionApp: host,
        },
        externalId: functionId(host, cron.id),
        externalUrl: null,
      });
    }

    // The retry ceiling before a message is poisoned is HOST-wide on Azure (one
    // host.json per app), so it's resolved once per workload and reported as the value
    // that actually applies to every queue in this app — not as each queue's request.
    const owned = w.queueNames.map((n) => queueByName.get(n)).filter((q) => q !== undefined);
    const { value: maxDequeueCount } = azureMaxDequeueCount(owned);

    for (const qName of w.queueNames) {
      const queue = queueByName.get(qName);
      if (!queue) continue;
      // The consumer function is registered under the queue name (see registerAzureQueue),
      // so that — not the queue id — is the function sub-resource the portal addresses.
      // `type: "queue"` matches the AWS report so the dashboard's queue→function graph
      // renders identically; fifo is always false (Storage Queues have no FIFO) and there's
      // no per-queue batchSize, so the metadata is intentionally thinner than SQS's.
      const dlqTarget = dlqBySource.get(queue.name);
      const dlqQueue = dlqTarget === undefined ? undefined : queueByName.get(dlqTarget);
      const sharedDlq = unwired.get(queue.name);
      resources.push({
        name: queue.id,
        type: "queue",
        action,
        metadata: {
          queueName: queue.name,
          fifo: false,
          functionApp: host,
          // Nodes are keyed by resource id, so the target is reported as the DLQ
          // queue's id — the same name→id translation the AWS report does.
          ...(dlqQueue && {
            dlq: {
              queue: dlqQueue.id,
              ...(maxDequeueCount !== undefined && { maxReceiveCount: maxDequeueCount }),
              poisonQueue: azurePoisonQueueName(queue.name),
            },
          }),
          ...(sharedDlq !== undefined && {
            warnings: [
              `dlq "${sharedDlq}" is shared with another queue, so it isn't wired up on ` +
                `Azure: failures land in "${azurePoisonQueueName(queue.name)}" unread. ` +
                `Give this queue its own dlq to have them delivered.`,
            ],
          }),
        },
        externalId: functionId(host, queue.name),
        externalUrl: null,
      });
    }
  }

  // Missing env is an APP-level warning (every app gets the same settings). Surface it
  // on the first function resource — the http proxy when present, otherwise the first
  // cron/queue — so it's visible and never dropped.
  if (missingEnv.length && resources[0]) {
    // Appended, not assigned: that first row may already carry its own warning (an
    // unwired shared dlq), and overwriting it would silently drop it.
    const existing = resources[0].metadata.warnings ?? [];
    resources[0].metadata = {
      ...resources[0].metadata,
      warnings: [...existing, `env with no value: ${missingEnv.join(", ")}`],
    };
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
