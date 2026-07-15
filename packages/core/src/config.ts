import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { CloudProvider, ComputeConfig, CorsConfig, Framework } from "./ir.js";

/** Queue-only tuning knobs (SQS + event-source). */
export interface QueueTuning {
  /** FIFO content-based dedup (FIFO queues only). */
  contentBasedDedup?: boolean;
  /** Seconds a message stays hidden while processed. Must be >= the consumer timeout. */
  visibilityTimeout?: number;
  /** Seconds to wait gathering a fuller batch before invoking. */
  maxBatchingWindow?: number;
  /** Report per-message failures so only failed items retry. */
  reportBatchItemFailures?: boolean;
  /** Seconds an undelivered message is retained on the source queue. */
  messageRetention?: number;
}

/** Cron-only tuning knobs (schedule + async-invoke). */
export interface CronTuning {
  /** IANA timezone for the schedule. */
  timezone?: string;
  /** Async-invoke retry attempts (0–2). */
  retryAttempts?: number;
  /** Max age (seconds) of an event before async retries are abandoned. */
  maxEventAge?: number;
}

/**
 * DLQ for a queue — the id of another declared queue, plus the required
 * `maxReceiveCount` (after N failed receives → dead-letter). `Q` is the union of
 * this project's queue names, so the generated config autocompletes `queue` to a
 * real target; it defaults to `string` for the untyped fallback.
 */
export interface QueueDlq<Q extends string = string> {
  queue: Q;
  maxReceiveCount: number;
}

/** DLQ for a cron — the id of another declared queue. A failed async invoke dead-letters immediately, so there's no receive count. */
export interface CronDlq<Q extends string = string> {
  queue: Q;
}

/** Per-resource overrides for the HTTP proxy: compute knobs only. */
export type HttpResourceConfig = ComputeConfig;

/**
 * Compute for one worker Lambda, keyed by its module name. Under consolidation a
 * Nest module is a single function, so memory/timeout/etc. live here — not on the
 * individual cron/queue, which only owns its trigger (see `*TriggerConfig`).
 */
export type WorkerResourceConfig = ComputeConfig;

/**
 * A queue's TRIGGER‑level tuning (SQS + event source + DLQ) — no compute. Used for
 * a grouped Nest queue, whose compute lives on its worker module. `Q` (the queue‑
 * name union) types the DLQ target for autocomplete.
 */
export interface QueueTriggerConfig<Q extends string = string> extends QueueTuning {
  dlq?: QueueDlq<Q>;
}

/** A cron's TRIGGER‑level tuning (schedule + async‑invoke + DLQ) — no compute. */
export interface CronTriggerConfig<Q extends string = string> extends CronTuning {
  dlq?: CronDlq<Q>;
}

/**
 * Per-resource overrides for a STANDALONE queue consumer (Express, or a function‑
 * style queue in Nest): compute + trigger, since the handler is its own Lambda.
 */
export interface QueueResourceConfig<Q extends string = string>
  extends ComputeConfig, QueueTriggerConfig<Q> {}

/** Per-resource overrides for a STANDALONE cron: compute + trigger (its own Lambda). */
export interface CronResourceConfig<Q extends string = string>
  extends ComputeConfig, CronTriggerConfig<Q> {}

/**
 * The loose, kind-agnostic override shape — every knob optional and `dlq`'s
 * `maxReceiveCount` optional. Used by the scanner (which validates per kind at
 * scan time) and by the untyped `resources: Record<string, ResourceConfig>`
 * fallback. Opt into `TypedLaranjaConfig` (from the generated `laranja.types.ts`)
 * for per-kind compile-time typing that requires `maxReceiveCount` on a queue DLQ
 * and rejects a foreign knob before deploy instead of only at scan time.
 */
export interface ResourceConfig extends ComputeConfig, QueueTuning, CronTuning {
  dlq?: { queue: string; maxReceiveCount?: number };
}

/** User-authored config, loaded from `laranja.config.ts`. */
export interface LaranjaConfig {
  /** App name — used for the CloudFormation stack and resource naming. */
  name: string;
  /**
   * Project id from your laranja dashboard. Identifies this project on the
   * server (scoping, limits, deploy timeline); sent as the `x-project-id`
   * header on `/synth`. Obtain it when you create the project in the dashboard.
   */
  projectId?: string;
  /** Target cloud. Only "aws" is implemented today. Defaults to "aws". */
  provider?: CloudProvider;
  region?: string;
  /** AWS named profile to deploy with. */
  profile?: string;
  /** Override framework detection. */
  framework?: Framework;
  /** Deployment stage; part of resource names (e.g. "dev", "prod"). Defaults to "dev". */
  stage?: string;
  /** Plain env injected into every Lambda. */
  env?: Record<string, string>;
  /**
   * Emit a per-app-stage monitoring dashboard (`<name>-<stage>`) with per-function
   * invocations / errors / throttles / duration for the HTTP proxy and every
   * cron/queue consumer. Provider-neutral — each back half maps it to its own
   * primitives. HTTP status classes (2xx/4xx/5xx) come later with API Gateway.
   * Defaults to true.
   */
  monitoring?: boolean;
  /**
   * Cross-origin resource sharing for your HTTP app's public endpoint. Omitted (the
   * default) means CORS off — the browser only allows same-origin requests. Opt in
   * by listing what you want to allow:
   *
   *   cors: { allowOrigins: ["https://app.example.com"], allowMethods: ["GET", "POST"] }
   *
   * Provider-neutral; on AWS it configures the Lambda Function URL's CORS. Has no
   * effect on a workers-only project (there's no HTTP endpoint to open).
   */
  cors?: CorsConfig;
  /**
   * Default compute config (memory, timeout, …) applied to every function — the
   * HTTP proxy and each cron/queue consumer. Override per-resource via `resources`.
   */
  compute?: ComputeConfig;
  /**
   * Per-resource overrides keyed by resource id ("http", or a cron/queue id).
   * Each merges on top of `compute`, field by field. An unknown id is a hard
   * error at scan time so a typo never silently no-ops.
   */
  resources?: Record<string, ResourceConfig>;
}

export const CONFIG_FILENAME = "laranja.config.ts";

/** Overrides applied on top of the loaded config — e.g. a `--stage` CLI flag. */
export interface ConfigOverrides {
  /** Wins over `config.stage`. Used by the `--stage`/`-s` flag for per-stage pipelines. */
  stage?: string;
}

/**
 * The CloudFormation stack name for a project + stage: `<name>-<stage>`.
 *
 * Stage is part of the stack name (not just the Lambda names) so two stages can
 * be deployed to the SAME account without colliding — one definition, two
 * independent stacks. With separate dev/prod accounts the suffix is harmless.
 * Single source of truth: every command must derive the stack name from here.
 */
export function stackName(name: string, stage: string): string {
  return `${name}-${stage}`;
}

/**
 * The monitoring dashboard's physical name: `<name>-<stage>`, sanitized to the
 * chars CloudWatch allows (A–Z a–z 0–9 - _) and capped at 255.
 *
 * Single source of truth: the back half names the dashboard from here, and the
 * client builds the console deep link (`externalUrl`) from here, so the two can
 * never drift. Provider-neutral name; each back half maps it to its own dashboard.
 */
export function dashboardName(name: string, stage: string): string {
  return `${name}-${stage}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 255);
}

/**
 * `laranja.config.ts` is ESM (`export default`), but the project it lives in is
 * almost always "typeless" — a Nest/Express app whose package.json has no
 * `"type": "module"` because its own build is CommonJS. Importing the config then
 * makes Node detect the format by syntax and print a MODULE_TYPELESS_PACKAGE_JSON
 * warning the user can't act on without breaking their app's CJS build. It's
 * laranja's config, so laranja swallows exactly that one warning code — everything
 * else Node emits still gets through. Idempotent; installed once, lazily.
 */
let typelessWarningSilenced = false;
function silenceTypelessConfigWarning(): void {
  if (typelessWarningSilenced) return;
  typelessWarningSilenced = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const opt = args[0];
    const code = opt && typeof opt === "object" ? (opt as { code?: string }).code : args[1];
    if (code === "MODULE_TYPELESS_PACKAGE_JSON") return;
    return (original as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

/**
 * Loads `laranja.config.ts` from the project dir. Runs under tsx, so importing a
 * TypeScript config module Just Works. Returns the config with defaults applied,
 * then any `overrides` (e.g. a `--stage` flag) layered on top.
 */
export async function loadConfig(
  projectDir: string,
  overrides: ConfigOverrides = {},
): Promise<
  Required<Pick<LaranjaConfig, "env" | "stage" | "provider" | "monitoring">> &
    LaranjaConfig
> {
  const file = path.join(projectDir, CONFIG_FILENAME);
  if (!existsSync(file)) {
    throw new Error(
      `No ${CONFIG_FILENAME} found in ${projectDir}. Run \`laranja init\` first.`,
    );
  }
  silenceTypelessConfigWarning();
  const mod = await import(pathToFileURL(file).href);
  const cfg: LaranjaConfig | undefined = mod.default ?? mod.config;
  if (!cfg) {
    throw new Error(
      `${CONFIG_FILENAME} must \`export default\` a config object.`,
    );
  }
  if (!cfg.name) {
    throw new Error(
      `${CONFIG_FILENAME}: "name" is required — run \`laranja init\` to link this directory to a project.`,
    );
  }
  // The HTTP app is declared in code via an `http(app)` marker, which the scanner
  // resolves — there's no config field for it. The scanner raises a clear error
  // if there's ultimately nothing to deploy.
  // Only AWS is implemented today. Reject any other provider up front so a
  // forward-compatible config field never silently deploys to the wrong (or no)
  // back-half. This guard goes away per-arm once a discriminated union of real
  // providers exists.
  if (cfg.provider && cfg.provider !== "aws") {
    throw new Error(
      `${CONFIG_FILENAME}: provider "${cfg.provider}" isn't supported yet — only "aws" today.`,
    );
  }
  return {
    stage: "dev",
    provider: "aws",
    monitoring: true,
    env: {},
    ...cfg,
    // Overrides win over both defaults and the config file (only when set).
    ...(overrides.stage ? { stage: overrides.stage } : {}),
  };
}
