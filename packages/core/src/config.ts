import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { CloudProvider, Framework } from "./ir.js";

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
  /**
   * Set to `false` to deploy workers only (@Cron/@Queue) with no HTTP app —
   * for teams whose API is already hosted elsewhere. When omitted, the HTTP
   * proxy is deployed and `entry` is required.
   */
  http?: false;
  /** Project-relative module that exports the framework app. Required unless `http: false`. */
  entry?: string;
  /** Named export of the app within `entry`. Defaults to "app". */
  appExport?: string;
  /** Plain env injected into every Lambda. */
  env?: Record<string, string>;
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
): Promise<Required<Pick<LaranjaConfig, "appExport" | "env" | "stage" | "provider">> & LaranjaConfig> {
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
  // `entry` is intentionally NOT required here: the HTTP app may instead be
  // declared in code via an `http(app)` marker, which the scanner resolves. The
  // scanner raises a clear error if there's ultimately nothing to deploy.
  return {
    appExport: "app",
    stage: "dev",
    provider: "aws",
    env: {},
    ...cfg,
    // Overrides win over both defaults and the config file (only when set).
    ...(overrides.stage ? { stage: overrides.stage } : {}),
  };
}
