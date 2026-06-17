import path from "node:path";
import { rmSync } from "node:fs";
import { loadConfig, type InfraIR } from "@laranja/core";
import { scan } from "@laranja/scanner";
import { generateEntries } from "@laranja/runtime";
import { bundleEntries, synth } from "@laranja/cdk";

export interface Assembly {
  ir: InfraIR;
  stackName: string;
  /** Absolute path to the synthesized cloud assembly (cdk.out). */
  cdkOutDir: string;
  region?: string;
}

/**
 * The shared front-to-back pipeline used by every command that needs infra:
 * scan -> generate shims -> bundle -> synth, all into ephemeral `.laranja/`.
 */
export async function buildAssembly(
  projectDir: string,
  env?: { region?: string; account?: string },
): Promise<Assembly> {
  const outRoot = path.join(projectDir, ".laranja");
  const entryDir = path.join(outRoot, "entries");
  const buildDir = path.join(outRoot, "build");
  const cdkOutDir = path.join(outRoot, "cdk.out");

  rmSync(outRoot, { recursive: true, force: true });

  const config = await loadConfig(projectDir);
  const ir = scan({ projectDir, config });
  const entries = generateEntries(ir, { projectDir, entryDir });
  const handlers = await bundleEntries(entries, { entryDir, buildDir });
  synth(ir, handlers, {
    outdir: cdkOutDir,
    stackName: config.name,
    region: env?.region ?? config.region,
    account: env?.account,
  });

  return { ir, stackName: config.name, cdkOutDir, region: env?.region ?? config.region };
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
