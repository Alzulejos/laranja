/**
 * Turn a deployed IR into the resource inventory the dashboard expects
 * (`POST /deployment/:id/resources`). One row per LOGICAL laranja resource —
 * the http proxy, each cron, each queue — not per physical AWS resource.
 *
 * Every resource is reported on every deploy, so the dashboard always shows the
 * full outcome. ARNs are reconstructed deterministically from the IR: the stack
 * pins each Lambda's `functionName` to `<app>-<label>-<stage>`, so the ARN is
 * `arn:aws:lambda:<region>:<account>:function:<that name>`. The Function URL
 * (http only) isn't reconstructable, so it comes from the stack outputs.
 *
 * Grouping: a Nest `workers()` module compiles to ONE shared worker Lambda that
 * hosts every method-style `@Cron`/`@Queue` it owns (see laranja-cdk `stack.ts`).
 * Such handlers carry a `workersId` (the module id) — the physical function label
 * is that id, NOT the handler's own name, so every grouped cron/queue resolves to
 * the same worker ARN. Each stays its own logical resource (its own node), so the
 * dashboard renders e.g. two queues both pointing at one `<module>` Lambda; the
 * `metadata.worker` field names that owning function for grouping/labels.
 */

import {
  dashboardName,
  describeSchedule,
  handlerLabel,
  handlerName,
  type InfraIR,
  type DeployedResource,
  type DeployedResourceAction,
  type DeployedResourceType,
  type ResourceMetadata,
} from "@alzulejos/laranja-core";
import type { PriorNodeLambda } from "./aws.js";

export interface BuildResourcesArgs {
  ir: InfraIR;
  region: string;
  account: string;
  /** Parsed CloudFormation outputs for the stack (e.g. `HttpUrl`). */
  outputs: Record<string, string>;
  /** env keys with no value at deploy — surfaced as per-resource `metadata.warnings`. */
  missingEnv: string[];
  /**
   * Physical resource ids present in the stack BEFORE this deploy (from
   * `getStackSnapshot`). A resource whose physical id is in this set is being
   * UPDATED; anything else is CREATED. Empty on a first deploy → all CREATED.
   */
  priorPhysicalIds: Set<string>;
  /**
   * laranja node Lambdas present in the stack BEFORE this deploy. Any that the
   * current IR no longer produces are reported as REMOVED. Empty on a first deploy.
   */
  priorNodeLambdas: PriorNodeLambda[];
}

/**
 * Physical Lambda name — must match laranja-cdk `stack.ts` `fnName()`:
 * `<app>-<label>-<stage>`, non-alphanumerics collapsed to "-", capped at 64.
 */
function functionName(ir: InfraIR, label: string): string {
  return `${ir.app.name}-${label}-${ir.app.stage}`.replace(/[^A-Za-z0-9-_]/g, "-").slice(0, 64);
}

export function buildDeployedResources(args: BuildResourcesArgs): DeployedResource[] {
  const { ir, region, account, outputs, missingEnv, priorPhysicalIds, priorNodeLambdas } = args;

  // env warnings are app-wide (one process.env, shared by every Lambda), so they
  // attach to each resource. `metadata` must be an object, never null.
  const meta = (extra: Record<string, unknown> = {}): ResourceMetadata =>
    missingEnv.length ? { ...extra, warnings: missingEnv } : { ...extra };
  const arn = (label: string): string =>
    `arn:aws:lambda:${region}:${account}:function:${functionName(ir, label)}`;

  // A resource whose pinned physical name was already in the stack is being
  // modified; otherwise it's new. Lambdas key off their `<app>-<label>-<stage>`
  // function name, the monitoring dashboard off its `<app>-<stage>` name.
  const actionFor = (physicalId: string): DeployedResourceAction =>
    priorPhysicalIds.has(physicalId) ? "UPDATED" : "CREATED";

  // The physical Lambda names this deploy still produces. Any prior node Lambda
  // NOT in here was deleted from code → reported as REMOVED below.
  const liveFnNames = new Set<string>();
  const live = (label: string): string => {
    const fn = functionName(ir, label);
    liveFnNames.add(fn);
    return fn;
  };

  const resources: DeployedResource[] = [];

  // The monitoring dashboard is one physical AWS::CloudWatch::Dashboard named
  // `<app>-<stage>` (see laranja-cdk). It has no ARN worth showing; the value is
  // the console deep link, stored BE-side as `externalUrl` so the FE renders a
  // clickable node without knowing the provider. Other providers fill the same
  // field with their own console URL.
  if (ir.app.monitoring) {
    const name = dashboardName(ir.app.name, ir.app.stage);
    resources.push({
      name: "monitoring",
      type: "dashboard",
      action: actionFor(name),
      metadata: meta(),
      externalId: null,
      externalUrl: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards/dashboard/${name}`,
    });
  }

  if (ir.http) {
    resources.push({
      name: "http",
      type: "http",
      action: actionFor(live("app")),
      metadata: meta(),
      externalId: arn("app"),
      externalUrl: outputs.HttpUrl ?? null,
    });
  }

  for (const cron of ir.crons) {
    const label = cron.workersId ?? handlerLabel(cron);
    resources.push({
      name: cron.id,
      type: "cron",
      action: actionFor(live(label)),
      // Store a ready-to-display label alongside the structured schedule so the
      // dashboard shows "Every minute" without re-deriving it from the cron string.
      metadata: meta({
        schedule: { ...cron.schedule, description: describeSchedule(cron.schedule) },
        ...(cron.workersId && { worker: cron.workersId }),
      }),
      // Grouped Nest crons run in their module's shared worker Lambda (label =
      // workersId); a standalone cron owns its own function (label = handler name).
      externalId: arn(label),
      externalUrl: null,
    });
  }

  // A queue's DLQ target is another declared queue, referenced by its SQS `name`.
  // Resource nodes are keyed by `q.id`, so translate name→id here — the dashboard
  // draws the redrive edge (source queue → DLQ queue) directly between nodes.
  const idByQueueName = new Map(ir.queues.map((q) => [q.name, q.id]));

  for (const q of ir.queues) {
    const label = q.workersId ?? handlerName(q);
    resources.push({
      name: q.id,
      type: "queue",
      action: actionFor(live(label)),
      metadata: meta({
        queueName: q.name,
        fifo: Boolean(q.fifo),
        batchSize: q.batchSize ?? 10,
        queueArn: `arn:aws:sqs:${region}:${account}:${q.name}`,
        ...(q.dlq && {
          dlq: {
            queue: idByQueueName.get(q.dlq.queue) ?? q.dlq.queue,
            maxReceiveCount: q.dlq.maxReceiveCount,
          },
        }),
        ...(q.workersId && { worker: q.workersId }),
      }),
      // Grouped Nest queues share their module's worker Lambda (label = workersId);
      // a standalone queue owns its own consumer function (label = handler name).
      externalId: arn(label),
      externalUrl: null,
    });
  }

  // REMOVED: any laranja node Lambda that was in the stack before but this deploy
  // no longer produces (a cron/queue/worker deleted from code, or http dropped).
  // Each deployment stores its own inventory as history, so this is just a row in
  // THIS deploy's snapshot — no reconciliation against a persistent node needed.
  const appPrefix = `${ir.app.name}-`;
  const stageSuffix = `-${ir.app.stage}`;
  // Best-effort friendly name: undo `fnName`'s `<app>-<label>-<stage>` wrapping.
  const labelOf = (fn: string): string => {
    let s = fn;
    if (s.startsWith(appPrefix)) s = s.slice(appPrefix.length);
    if (s.endsWith(stageSuffix)) s = s.slice(0, -stageSuffix.length);
    return s;
  };
  for (const prior of priorNodeLambdas) {
    if (liveFnNames.has(prior.functionName)) continue;
    const isHttp = prior.logicalId.startsWith("HttpFn");
    const type: DeployedResourceType = isHttp
      ? "http"
      : prior.logicalId.startsWith("Cron")
        ? "cron"
        : prior.logicalId.startsWith("Consumer")
          ? "queue"
          : "function"; // Worker<id>Fn — a shared worker module Lambda.
    resources.push({
      name: isHttp ? "http" : labelOf(prior.functionName),
      type,
      action: "REMOVED",
      metadata: {},
      externalId: `arn:aws:lambda:${region}:${account}:function:${prior.functionName}`,
      externalUrl: null,
    });
  }

  // A monitoring dashboard that existed before but is now switched off is REMOVED.
  if (!ir.app.monitoring && priorPhysicalIds.has(dashboardName(ir.app.name, ir.app.stage))) {
    resources.push({
      name: "monitoring",
      type: "dashboard",
      action: "REMOVED",
      metadata: {},
      externalId: null,
      externalUrl: null,
    });
  }

  return resources;
}
