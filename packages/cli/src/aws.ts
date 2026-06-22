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
