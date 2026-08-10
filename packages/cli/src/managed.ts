/**
 * Managed hosting (`provider: "laranja"`) — the client half.
 *
 * A managed project has no cloud account of its own. The server owns the
 * subscription, provisions a resource group per project+stage, and lends this
 * process a short-lived token scoped to just that group. Everything after that
 * is the ORDINARY Azure executor: the deploy, the package upload and the log
 * queries all still run here, and the server never sees the code or the zip.
 *
 * The seam is deliberately one object. `azure.ts` asks for a credential and a
 * target; in BYO-cloud mode those come from `az login` and laranja.config.ts, in
 * managed mode from the server. Nothing below that layer knows the difference.
 */

import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/identity";
import {
  postCloudCredentials,
  resolveApiKey,
  resolveDeployTarget,
  type CloudCredentialsResponse,
  type CloudTokenAudience,
  type ConfiguredProvider,
} from "@alzulejos/laranja-core";
import { useAzureCredential, type AzureTarget } from "./azure.js";

/** Re-request this long before expiry, so a slow deploy can't 401 mid-flight. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * A `TokenCredential` whose tokens come from the laranja server rather than a
 * local login.
 *
 * Implementing the SDK's own interface (instead of passing a raw string around)
 * is what keeps the change small: `DeploymentsClient`, the SCM publish and the
 * Log Analytics query all take a credential, so they keep working untouched —
 * including the refresh they already do on long operations.
 */
export class ManagedAzureCredential implements TokenCredential {
  /** One cached token per audience; ARM and Log Analytics are separate tokens. */
  private readonly cache = new Map<CloudTokenAudience, AccessToken>();

  constructor(
    private readonly apiKey: string,
    private readonly projectId: string,
    private readonly stage: string,
    /** Set from the first response so callers can read the target for free. */
    private lastTarget?: AzureTarget & { location: string },
  ) {}

  get target(): (AzureTarget & { location: string }) | undefined {
    return this.lastTarget;
  }

  async getToken(
    scopes: string | string[],
    _options?: GetTokenOptions,
  ): Promise<AccessToken | null> {
    const audience = audienceFor(scopes);

    const cached = this.cache.get(audience);
    if (cached && cached.expiresOnTimestamp - REFRESH_SKEW_MS > Date.now()) {
      return cached;
    }

    const res = await this.fetch(audience);
    const token: AccessToken = {
      token: res.token,
      expiresOnTimestamp: new Date(res.expiresOn).getTime(),
    };
    this.cache.set(audience, token);
    return token;
  }

  /** Ask the server for a token, provisioning the stage's infra on first call. */
  private async fetch(
    audience: CloudTokenAudience,
  ): Promise<CloudCredentialsResponse> {
    const res = await postCloudCredentials(
      { stage: this.stage, audience },
      this.apiKey,
      this.projectId,
    );
    this.lastTarget = { ...res.target };
    return res;
  }
}

/**
 * Map an Azure SDK scope to the audience the server mints for.
 *
 * The SDK asks for a scope URL; the server takes a short name. Anything that
 * isn't Log Analytics is ARM — deploy, what-if, package publish and every
 * resource read all share that audience.
 */
function audienceFor(scopes: string | string[]): CloudTokenAudience {
  const list = Array.isArray(scopes) ? scopes : [scopes];
  return list.some((s) => s.includes("loganalytics")) ? "logs" : "arm";
}

/**
 * Build the managed credential for a project+stage, and resolve its target.
 *
 * This is the call that triggers server-side provisioning, so it is also the
 * first place a managed deploy can fail — before anything is built or uploaded.
 */
export async function openManagedSession(
  projectId: string,
  stage: string,
): Promise<{ credential: ManagedAzureCredential; target: AzureTarget & { location: string } }> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to deploy.");
  }

  const credential = new ManagedAzureCredential(apiKey, projectId, stage);
  // Force the first round trip so the target is known (and provisioning has
  // happened) before the caller starts doing real work.
  await credential.getToken("https://management.azure.com/.default");

  const target = credential.target;
  if (!target) {
    throw new Error(
      "The laranja server did not return a deployment target for this project.",
    );
  }
  return { credential, target };
}

/** The config fields the Azure executor needs to find its target. */
export interface AzureTargetConfig {
  provider?: ConfiguredProvider;
  projectId?: string;
  stage: string;
  azure?: { subscriptionId: string; resourceGroup: string };
}

/**
 * Where this project deploys — and, for managed projects, installing the
 * credential that can deploy there.
 *
 * Every Azure command funnels through this instead of reading `config.azure`
 * directly, because a managed project has no such block: its subscription and
 * resource group are the server's answer, not the user's input.
 */
export async function resolveAzureTarget(
  config: AzureTargetConfig,
): Promise<AzureTarget & { location?: string }> {
  if (!resolveDeployTarget(config.provider).managed) {
    // loadConfig guarantees both for an azure project, so a miss here is a bug.
    return {
      subscriptionId: config.azure!.subscriptionId,
      resourceGroup: config.azure!.resourceGroup,
    };
  }

  if (!config.projectId) {
    throw new Error(
      'Set "projectId" in laranja.config.ts (from your dashboard) — managed hosting needs it to find your infrastructure.',
    );
  }

  const { credential, target } = await openManagedSession(
    config.projectId,
    config.stage,
  );
  useAzureCredential(credential);
  return target;
}
