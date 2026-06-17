import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

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
