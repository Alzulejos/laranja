/**
 * Azure-specific contracts shared across halves.
 *
 * These live in core for the same reason `envParamName` / `queueUrlEnvName` do:
 * each is a single value that MUST agree across codebases that never import one
 * another. Putting them here makes the agreement explicit instead of a comment
 * in two repos.
 */

/**
 * The name the generated shim registers with `app.http(...)`.
 *
 * JOINT CONTRACT between `@alzulejos/laranja-runtime` (which registers it) and
 * the deployed app. Unlike a Lambda handler string, nothing in the ARM template
 * names this — the Functions host discovers registered functions from the
 * package — but it IS the function's identity in logs, metrics and per-function
 * scaling, so both sides must agree.
 */
export const AZURE_HTTP_FUNCTION_NAME = "api";

/**
 * ARM parameter name for a code-discovered `env("NAME")`.
 *
 * laranja-cdk declares the parameter; the CLI supplies its value at deploy time.
 * Both sides must compute it identically.
 *
 * Unlike the AWS `envParamName` (which strips non-alphanumerics and is therefore
 * lossy — `MY_SECRET` and `MYSECRET` collide), ARM parameter names permit
 * underscores, so this mapping is injective and needs no collision guard.
 */
export function armParamName(key: string): string {
  return `env_${key.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/**
 * `host.json` for the deployment package.
 *
 * Lives here, not in the synth package, because the package hash is computed
 * client-side BEFORE `/synth` runs — a server-emitted host.json could not
 * influence the hash, so a timeout change would silently reuse a stale package.
 *
 * The function timeout is a host.json setting, NOT an ARM property, which is why
 * this exists at all.
 */
export function buildAzureHostJson(timeoutSeconds: number): Record<string, unknown> {
  return {
    version: "2.0",
    functionTimeout: toHhMmSs(timeoutSeconds),
    extensions: {
      http: {
        // Azure prefixes HTTP routes with "/api" by default. laranja serves a
        // whole app at root, and the shim forwards the incoming path straight to
        // the framework — so an "/api" prefix would forward "/api/foo" to an app
        // that only knows "/foo". Drop the prefix: routes sit at root and the
        // forwarded path matches what the user's app declared.
        routePrefix: "",
      },
    },
    extensionBundle: {
      id: "Microsoft.Azure.Functions.ExtensionBundle",
      // Flex Consumption requires this bundle range for non-C# apps.
      version: "[4.0.0, 5.0.0)",
    },
    logging: {
      applicationInsights: {
        samplingSettings: { isEnabled: true, excludedTypes: "Request" },
      },
    },
  };
}

/** Default wall-clock budget, matching the AWS HTTP proxy's 30s. */
export const AZURE_DEFAULT_TIMEOUT_SECONDS = 30;

/** host.json wants `HH:MM:SS`, not seconds. */
function toHhMmSs(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/* -------------------------------------------------------------------------- */
/* Resource naming                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Azure resource naming — SHARED between halves.
 *
 * The synth package names resources; the CLI must derive the same names to
 * upload the package and to tear things down. Deriving them (rather than
 * persisting a manifest) means `destroy` works from a clean checkout, on a
 * different machine, with no local state — which is the property Terraform's
 * state file conspicuously lacks.
 *
 * ⚠️ laranja-cdk currently carries its own copy of these because it consumes a
 * PUBLISHED core tarball. Import them from here on the next core release and
 * delete that copy; until then the two must be changed together.
 */

/** Lowercase, hyphen-separated, trimmed — the common case. */
function slug(parts: string[], max: number): string {
  return parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/**
 * Function app name. GLOBALLY unique (it becomes `<name>.azurewebsites.net`),
 * max 60 chars.
 */
export function azureFunctionAppName(app: string, stage: string, suffix?: string): string {
  return slug(suffix ? [app, stage, suffix] : [app, stage], 60);
}

/** Flex Consumption plan name. One app per plan, so it's named after the app. */
export function azurePlanName(app: string, stage: string): string {
  return slug([app, stage, "plan"], 40);
}

/** Application Insights component name. */
export function azureAppInsightsName(app: string, stage: string): string {
  return slug([app, stage, "ai"], 60);
}

/** Log Analytics workspace name — backs workspace-based App Insights. */
export function azureLogWorkspaceName(app: string, stage: string): string {
  return slug([app, stage, "logs"], 63);
}

/** User-assigned managed identity name — the app's stable runtime identity. */
export function azureManagedIdentityName(app: string, stage: string): string {
  return slug([app, stage, "id"], 128);
}

/**
 * Storage account name — the strictest rule in Azure: 3–24 chars, LOWERCASE
 * ALPHANUMERIC ONLY (hyphens are rejected), globally unique.
 */
export function azureStorageAccountName(app: string, stage: string, suffix?: string): string {
  const raw = `${app}${stage}${suffix ?? ""}st`.toLowerCase().replace(/[^a-z0-9]/g, "");
  const body = (/^[a-z]/.test(raw) ? raw : `l${raw}`).slice(0, 24);
  return body.length >= 3 ? body : `${body}str`.slice(0, 24);
}

/** Blob container holding the deployment package. */
export const AZURE_DEPLOYMENT_CONTAINER = "deploymentpackage";
