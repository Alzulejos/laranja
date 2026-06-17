import readline from "node:readline/promises";

/** Ask a yes/no question on the terminal. Defaults to no. */
export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Resolve the deploy region from config/env, or throw a clear error. */
export function requireRegion(configRegion: string | undefined): string {
  const region = configRegion ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error('No AWS region. Set "region" in laranja.config.ts (or AWS_REGION).');
  }
  return region;
}

/** Apply config-derived credentials/region to the environment for the AWS SDK + toolkit. */
export function applyAwsEnv(opts: { region: string; profile?: string }): void {
  if (opts.profile) process.env.AWS_PROFILE = opts.profile;
  process.env.AWS_REGION = opts.region;
  process.env.CDK_DISABLE_VERSION_CHECK = "1";
}
