import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  CloudFormationClient,
  ListStackResourcesCommand,
  DescribeStacksCommand,
  DeleteStackCommand,
  waitUntilStackDeleteComplete,
} from "@aws-sdk/client-cloudformation";

/** Resolve the AWS account id from the active credentials. */
export async function getAccountId(region: string): Promise<string> {
  const sts = new STSClient({ region });
  let res;
  try {
    res = await sts.send(new GetCallerIdentityCommand({}));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Couldn't authenticate with AWS (${msg}). ` +
        'Configure credentials (e.g. `aws configure` / SSO) or set "profile" in laranja.config.ts.',
    );
  }
  if (!res.Account) {
    throw new Error("Could not determine the AWS account from your credentials.");
  }
  return res.Account;
}

/** Kind of laranja-generated Lambda, inferred from its CDK logical id. */
export type LambdaKind = "http" | "cron" | "queue" | "lambda";

/** A deployed Lambda discovered from the live CloudFormation stack. */
export interface DeployedLambda {
  kind: LambdaKind;
  /** CloudFormation logical id, e.g. "HttpFn" / "CronnightlyReportFn". */
  logicalId: string;
  /** Physical function name (== CloudWatch log group suffix). */
  functionName: string;
  /** CloudWatch log group, e.g. "/aws/lambda/myapp-app-dev". */
  logGroupName: string;
}

/** Infer the kind of laranja Lambda from its CDK logical id prefix. */
export function lambdaKind(logicalId: string): LambdaKind {
  if (logicalId.startsWith("HttpFn")) return "http";
  if (logicalId.startsWith("Cron")) return "cron";
  if (logicalId.startsWith("Consumer")) return "queue";
  return "lambda";
}

/**
 * List the Lambda functions in a deployed laranja stack by querying the live
 * CloudFormation stack (the durable source of truth — no local state needed).
 * Throws a friendly error if the stack doesn't exist (i.e. nothing deployed).
 */
export async function listStackLambdas(region: string, stackName: string): Promise<DeployedLambda[]> {
  const cfn = new CloudFormationClient({ region });
  const out: DeployedLambda[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const res = await cfn.send(new ListStackResourcesCommand({ StackName: stackName, NextToken: nextToken }));
      for (const r of res.StackResourceSummaries ?? []) {
        if (r.ResourceType !== "AWS::Lambda::Function" || !r.PhysicalResourceId) continue;
        out.push({
          kind: lambdaKind(r.LogicalResourceId ?? ""),
          logicalId: r.LogicalResourceId ?? "",
          functionName: r.PhysicalResourceId,
          logGroupName: `/aws/lambda/${r.PhysicalResourceId}`,
        });
      }
      nextToken = res.NextToken;
    } while (nextToken);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "ValidationError") {
      // CloudFormation returns ValidationError for a non-existent stack.
      throw new Error(`No deployed stack "${stackName}" in ${region}. Run \`laranja deploy\` first.`);
    }
    throw err;
  }
  // Stable, readable order: http first, then crons, then queues.
  const rank: Record<LambdaKind, number> = { http: 0, cron: 1, queue: 2, lambda: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.functionName.localeCompare(b.functionName));
}

/**
 * A laranja *node* Lambda discovered in a deployed stack — one of the functions
 * that maps to a dashboard node (http proxy / cron / queue consumer / worker).
 * Identified by its CDK logical-id prefix, which excludes CDK-internal helper
 * Lambdas (log-retention, custom resources) that share the stack.
 */
export interface PriorNodeLambda {
  logicalId: string;
  functionName: string;
}

/**
 * CDK logical ids for laranja's node Lambdas, from laranja-cdk `stack.ts`:
 * `HttpFn`, `Cron<id>Fn`, `Consumer<id>Fn`, `Worker<id>Fn` (CDK appends a hash
 * suffix, so match by prefix). Nothing CDK creates on its own matches these.
 */
const NODE_LAMBDA_LOGICAL_ID = /^(HttpFn|Cron.*Fn|Consumer.*Fn|Worker.*Fn)/;

export interface StackSnapshot {
  /**
   * Every physical resource id in the stack — used to decide CREATED vs UPDATED
   * (a resource whose pinned physical name is already present is being modified).
   */
  physicalIds: Set<string>;
  /** laranja node Lambdas present before this deploy — used to detect REMOVED. */
  nodeLambdas: PriorNodeLambda[];
  /**
   * Pinned names of the EventBridge schedules present before this deploy — one per
   * logical cron (`<app>-<id>-<stage>`), whether the cron owns its Lambda or shares
   * a worker one. A cron removed from code deletes its schedule but NOT the shared
   * worker Lambda, so the schedule — not the Lambda — is what reveals the removal.
   */
  scheduleNames: Set<string>;
  /**
   * SQS queue names present before this deploy — one per logical queue (`q.name`).
   * Same story as schedules: a grouped queue removed from code deletes its queue
   * while its shared worker Lambda lives on.
   */
  queueNames: Set<string>;
}

/**
 * The trailing name segment of a CloudFormation physical id, however the resource
 * type encodes it: a plain name, an ARN (`.../schedule/default/<name>`), a
 * group‑qualified schedule (`default|<name>`), or an SQS URL (`.../<name>`). Our
 * pinned names never contain `/` or `|`, so the last segment is always the name.
 */
function physicalTail(id: string): string {
  return id.split(/[|/]/).pop() ?? id;
}

/**
 * Snapshot a deployed stack BEFORE the next deploy, so the resource report can
 * label each resource CREATED / UPDATED / REMOVED against live AWS state (no
 * local state to persist — the stack itself is the source of truth).
 *
 * laranja pins deterministic physical names — a Lambda's is its `<app>-<label>-<stage>`
 * function name, a dashboard's is `<app>-<stage>` — the same values `report.ts`
 * reconstructs, so membership checks line up. Returns an EMPTY snapshot when the
 * stack doesn't exist yet (first deploy → everything is CREATED) and, best-effort,
 * on any other error so a telemetry hiccup never blocks a deploy.
 */
export async function getStackSnapshot(region: string, stackName: string): Promise<StackSnapshot> {
  const cfn = new CloudFormationClient({ region });
  const physicalIds = new Set<string>();
  const nodeLambdas: PriorNodeLambda[] = [];
  const scheduleNames = new Set<string>();
  const queueNames = new Set<string>();
  let nextToken: string | undefined;
  try {
    do {
      const res = await cfn.send(new ListStackResourcesCommand({ StackName: stackName, NextToken: nextToken }));
      for (const r of res.StackResourceSummaries ?? []) {
        if (r.PhysicalResourceId) physicalIds.add(r.PhysicalResourceId);
        if (!r.PhysicalResourceId) continue;
        if (r.ResourceType === "AWS::Lambda::Function" && r.LogicalResourceId && NODE_LAMBDA_LOGICAL_ID.test(r.LogicalResourceId)) {
          nodeLambdas.push({ logicalId: r.LogicalResourceId, functionName: r.PhysicalResourceId });
        } else if (r.ResourceType === "AWS::Scheduler::Schedule") {
          scheduleNames.add(physicalTail(r.PhysicalResourceId));
        } else if (r.ResourceType === "AWS::SQS::Queue") {
          queueNames.add(physicalTail(r.PhysicalResourceId));
        }
      }
      nextToken = res.NextToken;
    } while (nextToken);
  } catch {
    // Missing stack (ValidationError) or any transient error → treat as no prior
    // state. Worst case a resource is labelled CREATED instead of UPDATED, which
    // is exactly the pre-existing behaviour, so this never regresses a deploy.
    return { physicalIds: new Set(), nodeLambdas: [], scheduleNames: new Set(), queueNames: new Set() };
  }
  return { physicalIds, nodeLambdas, scheduleNames, queueNames };
}

/**
 * Tear a deployed stack down by name — no synth needed, CloudFormation deletes
 * by stack name. Returns false if there's nothing to delete (no such stack).
 *
 * We grab the stack's unique id first and wait on THAT: once deletion finishes
 * the name no longer resolves, so a name-based waiter can't observe completion.
 */
export async function deleteStack(region: string, stackName: string): Promise<boolean> {
  const cfn = new CloudFormationClient({ region });

  let stackId: string | undefined;
  try {
    const desc = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    stackId = desc.Stacks?.[0]?.StackId;
  } catch (err) {
    // CloudFormation returns ValidationError for a non-existent stack.
    if (err instanceof Error && err.name === "ValidationError") return false;
    throw err;
  }

  await cfn.send(new DeleteStackCommand({ StackName: stackName }));
  await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 1800 }, { StackName: stackId ?? stackName });
  return true;
}

/**
 * Whether the account/region has been CDK-bootstrapped, detected via the SSM
 * version parameter the bootstrap stack writes.
 */
export async function isBootstrapped(region: string, qualifier = "hnb659fds"): Promise<boolean> {
  const ssm = new SSMClient({ region });
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `/cdk-bootstrap/${qualifier}/version` }));
    return Boolean(res.Parameter?.Value);
  } catch (err) {
    if (err instanceof Error && err.name === "ParameterNotFound") return false;
    throw err;
  }
}
