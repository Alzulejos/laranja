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
 */

import {
  describeSchedule,
  handlerLabel,
  handlerName,
  type InfraIR,
  type DeployedResource,
  type ResourceMetadata,
} from "@alzulejos/laranja-core";

export interface BuildResourcesArgs {
  ir: InfraIR;
  region: string;
  account: string;
  /** Parsed CloudFormation outputs for the stack (e.g. `HttpUrl`). */
  outputs: Record<string, string>;
  /** env keys with no value at deploy — surfaced as per-resource `metadata.warnings`. */
  missingEnv: string[];
}

/**
 * Physical Lambda name — must match laranja-cdk `stack.ts` `fnName()`:
 * `<app>-<label>-<stage>`, non-alphanumerics collapsed to "-", capped at 64.
 */
function functionName(ir: InfraIR, label: string): string {
  return `${ir.app.name}-${label}-${ir.app.stage}`.replace(/[^A-Za-z0-9-_]/g, "-").slice(0, 64);
}

export function buildDeployedResources(args: BuildResourcesArgs): DeployedResource[] {
  const { ir, region, account, outputs, missingEnv } = args;

  // env warnings are app-wide (one process.env, shared by every Lambda), so they
  // attach to each resource. `metadata` must be an object, never null.
  const meta = (extra: Record<string, unknown> = {}): ResourceMetadata =>
    missingEnv.length ? { ...extra, warnings: missingEnv } : { ...extra };
  const arn = (label: string): string =>
    `arn:aws:lambda:${region}:${account}:function:${functionName(ir, label)}`;

  const resources: DeployedResource[] = [];

  if (ir.http) {
    resources.push({
      name: "http",
      type: "http",
      action: "CREATED",
      metadata: meta(),
      externalId: arn("app"),
      externalUrl: outputs.HttpUrl ?? null,
    });
  }

  for (const cron of ir.crons) {
    resources.push({
      name: cron.id,
      type: "cron",
      action: "CREATED",
      // Store a ready-to-display label alongside the structured schedule so the
      // dashboard shows "Every minute" without re-deriving it from the cron string.
      metadata: meta({ schedule: { ...cron.schedule, description: describeSchedule(cron.schedule) } }),
      externalId: arn(handlerLabel(cron)),
      externalUrl: null,
    });
  }

  // A queue's DLQ target is another declared queue, referenced by its SQS `name`.
  // Resource nodes are keyed by `q.id`, so translate name→id here — the dashboard
  // draws the redrive edge (source queue → DLQ queue) directly between nodes.
  const idByQueueName = new Map(ir.queues.map((q) => [q.name, q.id]));

  for (const q of ir.queues) {
    resources.push({
      name: q.id,
      type: "queue",
      action: "CREATED",
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
      }),
      externalId: arn(handlerName(q)),
      externalUrl: null,
    });
  }

  return resources;
}
