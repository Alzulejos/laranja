import path from "node:path";
import { rmSync } from "node:fs";
import { loadConfig, resolveDeclaredEnv, stackName, type InfraIR } from "@laranja/core";
import { scan } from "@laranja/scanner";
import { generateEntries } from "@laranja/runtime";
import { bundleEntries, synth } from "@laranja/cdk";

export interface Assembly {
  ir: InfraIR;
  stackName: string;
  /** Absolute path to the synthesized cloud assembly (cdk.out). */
  cdkOutDir: string;
  region?: string;
  /**
   * Code-discovered env keys (`env("NAME")`) with no value in `process.env` at
   * build time. The Lambda is still synthesized without them — the caller decides
   * whether to warn (default) or fail (`--strict`).
   */
  missingEnv: string[];
}

/**
 * The shared front-to-back pipeline used by every command that needs infra:
 * scan -> generate shims -> bundle -> synth, all into ephemeral `.laranja/`.
 */
export async function buildAssembly(
  projectDir: string,
  env?: { region?: string; account?: string; stage?: string },
): Promise<Assembly> {
  const outRoot = path.join(projectDir, ".laranja");
  const entryDir = path.join(outRoot, "entries");
  const buildDir = path.join(outRoot, "build");
  const cdkOutDir = path.join(outRoot, "cdk.out");

  rmSync(outRoot, { recursive: true, force: true });

  const config = await loadConfig(projectDir, { stage: env?.stage });
  const name = stackName(config.name, config.stage);
  const ir = scan({ projectDir, config });
  // Resolve the code-discovered env("...") keys from the local/CI environment.
  // Values are injected into the Lambdas here and never enter the IR.
  const { resolved, missing } = resolveDeclaredEnv(ir.envKeys);
  const entries = generateEntries(ir, { projectDir, entryDir });
  const handlers = await bundleEntries(entries, { entryDir, buildDir });
  synth(ir, handlers, {
    outdir: cdkOutDir,
    stackName: name,
    region: env?.region ?? config.region,
    account: env?.account,
    runtimeEnv: resolved,
  });

  return { ir, stackName: name, cdkOutDir, region: env?.region ?? config.region, missingEnv: missing };
}

export function printPlan(ir: InfraIR): void {
  console.log(
    ir.http
      ? `  HTTP:    ${ir.http.routes.length} route(s) → 1 proxy Lambda + Function URL`
      : `  HTTP:    disabled (workers-only)`,
  );
  console.log(`  Cron:    ${ir.crons.length} job(s) → Lambda + EventBridge rule each`);
  console.log(`  Queues:  ${ir.queues.length} → SQS + consumer Lambda each`);
}
