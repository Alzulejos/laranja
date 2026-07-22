/**
 * Provider preflight — check the user's environment BEFORE a deploy touches the
 * cloud, and print exactly what to fix.
 *
 * Every check here maps to a real failure hit during the first Azure deploy:
 * unregistered resource providers, a resource group in a region that won't
 * accept new customers, missing credentials. Discovering those one failed
 * deploy at a time makes the user suspect laranja; a checklist up front doesn't.
 *
 * Each check is best-effort and NON-fatal to run: a network hiccup here must not
 * block a deploy that would otherwise work, so `runPreflight` returns whether
 * everything passed but the caller decides what to do with a partial result.
 */

import type { LaranjaConfig } from "@alzulejos/laranja-core";
import { managementToken } from "./azure.js";
import { getAccountId } from "./aws.js";
import * as ui from "./ui.js";

type CheckStatus = "ok" | "fail" | "unknown";

/**
 * What the caller is about to do. The right-access checks differ:
 * - deploy needs providers registered + the resource group present;
 * - destroy only needs credentials (deleting doesn't care about registration,
 *   and a missing group just means nothing to tear down);
 * - plan is a read-only preview — credentials + region.
 */
export type PreflightPurpose = "deploy" | "plan" | "destroy";

interface CheckResult {
  status: CheckStatus;
  label: string;
  /** Shown under a failing/unknown check — the command or step that fixes it. */
  fix?: string;
}

/** The Azure resource providers a Flex Consumption deploy needs registered. */
const AZURE_PROVIDERS = [
  "Microsoft.Web",
  "Microsoft.Storage",
  "Microsoft.Insights",
  "Microsoft.OperationalInsights",
];

/**
 * Run the preflight for the config's provider. Prints a checklist and returns
 * true only if every check passed (unknown counts as not-passed for the return
 * value, but is reported distinctly so a flaky network reads as "couldn't check"
 * rather than "broken").
 */
export async function runPreflight(
  config: LaranjaConfig,
  purpose: PreflightPurpose = "deploy",
): Promise<boolean> {
  const provider = config.provider ?? "aws";
  ui.header(`preflight · ${provider}`);

  const checks =
    provider === "azure" ? await azureChecks(config, purpose) : await awsChecks(config);

  for (const c of checks) {
    const icon = c.status === "ok" ? ui.green("✓") : c.status === "fail" ? ui.red("✗") : ui.dim("?");
    console.log(`  ${icon} ${c.label}`);
    if (c.status !== "ok" && c.fix) ui.note(`   ${c.fix}`);
  }

  const allOk = checks.every((c) => c.status === "ok");
  console.log();
  if (allOk) {
    console.log(`  ${ui.green("✓")} ${ui.bold("environment ready")}\n`);
  }
  return allOk;
}

/**
 * Run the preflight and, on failure, print the abort line. Returns whether it's
 * safe to proceed. The single gate every command calls right after loading
 * config, before doing any cloud work — so a missing permission or setup step is
 * caught up front with a fix, not mid-operation where it looks like laranja broke.
 */
export async function preflightOrAbort(config: LaranjaConfig, purpose: PreflightPurpose): Promise<boolean> {
  const ok = await runPreflight(config, purpose);
  if (!ok) ui.warn("environment isn't ready — fix the items above and re-run.");
  return ok;
}

async function awsChecks(config: LaranjaConfig): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  const region = config.region;
  checks.push(
    region
      ? { status: "ok", label: `region set (${region})` }
      : { status: "fail", label: "region not set", fix: 'Set `region` in laranja.config.ts (e.g. "eu-central-1").' },
  );

  // Credentials: resolving the account via STS proves they're usable.
  if (region) {
    try {
      const account = await getAccountId(region);
      checks.push({ status: "ok", label: `AWS credentials resolve (account ${account})` });
    } catch {
      checks.push({
        status: "fail",
        label: "AWS credentials don't resolve",
        fix: "Configure credentials (aws configure / SSO / env AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY).",
      });
    }
  }

  return checks;
}

async function azureChecks(config: LaranjaConfig, purpose: PreflightPurpose): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const sub = config.azure?.subscriptionId;
  const rg = config.azure?.resourceGroup;

  // 1. Config completeness — cheap, and everything below needs these.
  checks.push(
    sub
      ? { status: "ok", label: `subscription set (${sub})` }
      : { status: "fail", label: "azure.subscriptionId not set", fix: "Add `azure: { subscriptionId }` to laranja.config.ts (az account show --query id -o tsv)." },
  );
  checks.push(
    rg
      ? { status: "ok", label: `resource group set (${rg})` }
      : { status: "fail", label: "azure.resourceGroup not set", fix: "Add `azure: { resourceGroup }` to laranja.config.ts." },
  );

  // 2. Credentials — a management token proves DefaultAzureCredential works.
  let token: string | undefined;
  try {
    token = await managementToken();
    checks.push({ status: "ok", label: "Azure credentials resolve" });
  } catch {
    checks.push({
      status: "fail",
      label: "Azure credentials don't resolve",
      fix: "Run `az login` (or set AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID in CI).",
    });
  }

  // Without a token + subscription, the live checks below can't run.
  if (!token || !sub) return checks;

  // 3. Resource providers registered — an unregistered one fails a DEPLOY
  //    mid-flight with a "Failed to register resource provider" Conflict.
  //    Irrelevant to destroy (deleting doesn't register anything) and plan.
  if (purpose === "deploy") {
    for (const ns of AZURE_PROVIDERS) {
      const state = await azureProviderState(token, sub, ns);
      if (state === "Registered") {
        checks.push({ status: "ok", label: `provider ${ns} registered` });
      } else if (state === undefined) {
        checks.push({ status: "unknown", label: `provider ${ns} — couldn't check` });
      } else {
        checks.push({
          status: "fail",
          label: `provider ${ns} is ${state}`,
          fix: `az provider register --namespace ${ns}`,
        });
      }
    }
  }

  // 4. Resource group. A DEPLOY needs it to exist (it inherits its region); a
  //    destroy that finds it gone just has nothing to do, so that's informational.
  if (rg) {
    const location = await azureResourceGroupLocation(token, sub, rg);
    if (location) {
      checks.push({ status: "ok", label: `resource group exists (${rg} · ${location})` });
    } else if (location === null) {
      checks.push(
        purpose === "deploy"
          ? {
              status: "fail",
              label: `resource group "${rg}" not found`,
              fix: `Create it: az group create -n ${rg} -l <region>   (laranja deploys into an existing group).`,
            }
          : { status: "ok", label: `resource group "${rg}" already gone — nothing to destroy` },
      );
    } else {
      checks.push({ status: "unknown", label: `resource group "${rg}" — couldn't check` });
    }
  }

  return checks;
}

/** A provider's registrationState, or undefined if the check itself failed. */
async function azureProviderState(token: string, sub: string, ns: string): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://management.azure.com/subscriptions/${sub}/providers/${ns}?api-version=2021-04-01`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { registrationState?: string };
    return body.registrationState ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The resource group's location, `null` if it doesn't exist (404), or undefined
 * if the check itself couldn't run.
 */
async function azureResourceGroupLocation(
  token: string,
  sub: string,
  rg: string,
): Promise<string | null | undefined> {
  try {
    const res = await fetch(
      `https://management.azure.com/subscriptions/${sub}/resourcegroups/${rg}?api-version=2021-04-01`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const body = (await res.json()) as { location?: string };
    return body.location ?? undefined;
  } catch {
    return undefined;
  }
}
