import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { Framework } from "./ir.js";

/** User-authored config, loaded from `laranja.config.ts`. */
export interface LaranjaConfig {
  /** App name — used for the CloudFormation stack and resource naming. */
  name: string;
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

/**
 * Loads `laranja.config.ts` from the project dir. Runs under tsx, so importing a
 * TypeScript config module Just Works. Returns the config with defaults applied.
 */
export async function loadConfig(
  projectDir: string,
): Promise<Required<Pick<LaranjaConfig, "appExport" | "env" | "stage">> & LaranjaConfig> {
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
    env: {},
    ...cfg,
  };
}
