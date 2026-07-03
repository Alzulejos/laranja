import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { CloudProvider, ComputeConfig, Framework } from "./ir.js";

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
 * `maxReceiveCount` (after N failed receives → dead-letter).
 */
export interface QueueDlq {
  queue: string;
  maxReceiveCount: number;
}

/** DLQ for a cron — the id of another declared queue. A failed async invoke dead-letters immediately, so there's no receive count. */
export interface CronDlq {
  queue: string;
}

/** Per-resource overrides for the HTTP proxy: compute knobs only. */
export type HttpResourceConfig = ComputeConfig;

/** Per-resource overrides for a queue consumer: compute + queue tuning + a queue DLQ. */
export interface QueueResourceConfig extends ComputeConfig, QueueTuning {
  dlq?: QueueDlq;
}

/** Per-resource overrides for a cron: compute + cron tuning + a cron DLQ. */
export interface CronResourceConfig extends ComputeConfig, CronTuning {
  dlq?: CronDlq;
}

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
 * Loads `laranja.config.ts` from the project dir. Runs under tsx, so importing a
 * TypeScript config module Just Works. Returns the config with defaults applied,
 * then any `overrides` (e.g. a `--stage` flag) layered on top.
 */
export async function loadConfig(
  projectDir: string,
  overrides: ConfigOverrides = {},
): Promise<Required<Pick<LaranjaConfig, "env" | "stage" | "provider">> & LaranjaConfig> {
  const file = path.join(projectDir, CONFIG_FILENAME);
  if (!existsSync(file)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${projectDir}. Run \`laranja init\` first.`);
  }
  const mod = await import(pathToFileURL(file).href);
  const cfg: LaranjaConfig | undefined = mod.default ?? mod.config;
  if (!cfg) {
    throw new Error(`${CONFIG_FILENAME} must \`export default\` a config object.`);
  }
  if (!cfg.name) throw new Error(`${CONFIG_FILENAME}: "name" is required.`);
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
    env: {},
    ...cfg,
    // Overrides win over both defaults and the config file (only when set).
    ...(overrides.stage ? { stage: overrides.stage } : {}),
  };
}
