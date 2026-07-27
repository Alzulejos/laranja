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
 * App-settings key holding a cron's NCRONTAB schedule.
 *
 * JOINT CONTRACT across three halves that never import one another: laranja-cdk
 * (writes the app setting to the NCRONTAB string), the generated shim in
 * `@alzulejos/laranja-runtime` (binds its timer with `schedule: '%<this key>%'`),
 * and the Functions host (expands `%…%` from app settings at trigger time). All
 * must derive the same key from the cron id.
 *
 * ⚠️ laranja-cdk carries a value-identical copy (`cronScheduleSettingKey`) for the
 * same published-tarball reason the naming helpers below do — change both together.
 *
 * Linux Function App setting names are case-sensitive, so the id's case is
 * preserved; only non-alphanumerics fold to `_`.
 */
export function azureCronScheduleSettingKey(id: string): string {
  return `LARANJA_CRON_${id.replace(/[^A-Za-z0-9_]/g, "_")}_SCHEDULE`;
}

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
        // Sampling DROPS telemetry to save cost — wrong for a `logs` tail, where a
        // silently-missing line looks like a broken deploy. Keep everything; a
        // serverless app's log volume is small enough that completeness wins.
        samplingSettings: { isEnabled: false },
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

/**
 * Flex Consumption plan name. laranja gives each Function App its own plan, so the
 * suffix matches the app's — see `azureWorkloads` for why there can be several.
 */
export function azurePlanName(app: string, stage: string, suffix?: string): string {
  return slug(suffix ? [app, stage, suffix, "plan"] : [app, stage, "plan"], 40);
}

/** Application Insights component name. */
export function azureAppInsightsName(app: string, stage: string): string {
  return slug([app, stage, "ai"], 60);
}

/** Log Analytics workspace name — backs workspace-based App Insights. */
export function azureLogWorkspaceName(app: string, stage: string): string {
  return slug([app, stage, "logs"], 63);
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

/* -------------------------------------------------------------------------- */
/* Workloads                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One deployable unit on Azure: a Function App, its package, its process.
 *
 * A Function App is an all-or-nothing hosting unit — everything inside it ships in
 * one package and boots in one process — and memory/scale are set per app (they live
 * in the SITE's `functionAppConfig.scaleAndConcurrency`, not the plan). So the only
 * way to give a `workers()` root its own `memory`/`timeout` is to give it its own app.
 * That's what this split expresses.
 */
export interface AzureWorkload {
  /**
   * Stable id — the asset key, and what the client matches a zip to an app by.
   * `"http"` for the primary workload (even when it serves no HTTP app), else the
   * `workers()` root id.
   */
  id: string;
  /**
   * Function App name suffix. `undefined` for the primary workload, so it keeps the
   * historical `<name>-<stage>` name — renaming a Function App destroys and recreates
   * it, so this is what makes the split a non-breaking upgrade.
   */
  suffix?: string;
  /** The `workers()` root whose DI container this app hosts, if any. */
  workersId?: string;
  /** Does this app serve the `http()` app? */
  http: boolean;
  /** Cron ids hosted here — the keys `azureCronScheduleSettingKey` is derived from. */
  cronIds: string[];
  /** Queue NAMES hosted here — the keys `queueUrlEnvName` is derived from. */
  queueNames: string[];
}

/** The slice of the IR this grouping needs, so core's Azure contracts stay standalone. */
interface WorkloadInput {
  http?: unknown;
  crons: { id: string; workersId?: string }[];
  queues: { name: string; workersId?: string }[];
  workers?: { id: string }[];
}

/**
 * Group an IR into the Function Apps it deploys as.
 *
 * - The **primary** workload (`"http"`) hosts the `http()` app plus every handler that
 *   needs no dependency injection — function-style `cron()`/`queue()`, and any
 *   Express class handler. It's omitted entirely when there's nothing for it to host
 *   (a Nest project whose every handler belongs to a `workers()` root).
 * - Each `workers()` root becomes its **own** workload, so its `compute` applies.
 *
 * This keeps the common case at ONE app: an Express app with two crons has no roots,
 * so everything lands in the primary workload exactly as it does today. The split only
 * appears once a project declares `workers()`.
 */
export function azureWorkloads(ir: WorkloadInput): AzureWorkload[] {
  const roots = ir.workers ?? [];
  const rootIds = new Set(roots.map((w) => w.id));
  // A handler is DI-bound only if its root actually exists; a dangling workersId
  // would otherwise vanish from every workload and be silently undeployed.
  const isBound = (h: { workersId?: string }): boolean =>
    h.workersId !== undefined && rootIds.has(h.workersId);

  const workloads: AzureWorkload[] = [];

  const primaryCrons = ir.crons.filter((c) => !isBound(c)).map((c) => c.id);
  const primaryQueues = ir.queues.filter((q) => !isBound(q)).map((q) => q.name);
  if (ir.http !== undefined || primaryCrons.length > 0 || primaryQueues.length > 0) {
    workloads.push({
      id: "http",
      http: ir.http !== undefined,
      cronIds: primaryCrons,
      queueNames: primaryQueues,
    });
  }

  for (const root of roots) {
    const cronIds = ir.crons.filter((c) => c.workersId === root.id).map((c) => c.id);
    const queueNames = ir.queues.filter((q) => q.workersId === root.id).map((q) => q.name);
    // A root with no handlers bound to it hosts nothing — don't deploy an empty app.
    if (cronIds.length === 0 && queueNames.length === 0) continue;
    workloads.push({
      id: root.id,
      suffix: root.id,
      workersId: root.id,
      http: false,
      cronIds,
      queueNames,
    });
  }

  return workloads;
}
