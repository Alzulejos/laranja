import path from "node:path";
import { rmSync } from "node:fs";
import {
  loadConfig,
  postSynth,
  stackName,
  ApiRequestError,
  type InfraIR,
} from "@laranja/core";
import { scan } from "@laranja/scanner";
import { generateEntries } from "@laranja/runtime";
import { bundleEntries, computeAssetHashes, assembleFromTemplate, synth } from "@laranja/cdk";

export interface Assembly {
  ir: InfraIR;
  stackName: string;
  /** Absolute path to the synthesized cloud assembly (cdk.out). */
  cdkOutDir: string;
  region?: string;
}

/** A server-built assembly also carries the dashboard deployment id to echo back. */
export interface RemoteAssembly extends Assembly {
  deploymentId: string;
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
  const entries = generateEntries(ir, { projectDir, entryDir });
  const handlers = await bundleEntries(entries, { entryDir, buildDir });
  synth(ir, handlers, {
    outdir: cdkOutDir,
    stackName: name,
    region: env?.region ?? config.region,
    account: env?.account,
  });

  return { ir, stackName: name, cdkOutDir, region: env?.region ?? config.region };
}

/**
 * The remote counterpart of `buildAssembly`: scan -> generate shims -> bundle ->
 * fingerprint, then let the SERVER synth the template (no synth on this machine).
 * We bundle locally only to (a) fingerprint each handler with CDK's own asset
 * hash — which the server embeds into the template as `<hash>.zip` — and (b) have
 * the zips on hand so the toolkit can upload them at deploy. The source code
 * never leaves the machine; only the IR + hashes cross the wire.
 */
export async function buildRemoteAssembly(
  projectDir: string,
  env: { region?: string; account?: string; stage?: string },
  apiKey: string,
): Promise<RemoteAssembly> {
  const outRoot = path.join(projectDir, ".laranja");
  const entryDir = path.join(outRoot, "entries");
  const buildDir = path.join(outRoot, "build");
  const cdkOutDir = path.join(outRoot, "cdk.out");

  rmSync(outRoot, { recursive: true, force: true });

  const config = await loadConfig(projectDir, { stage: env.stage });
  if (!config.projectId) {
    throw new Error('Set "projectId" in laranja.config.ts (from your dashboard) to deploy via the server.');
  }
  const ir = scan({ projectDir, config });
  const entries = generateEntries(ir, { projectDir, entryDir });
  const handlers = await bundleEntries(entries, { entryDir, buildDir });
  const assets = computeAssetHashes(handlers);

  let res;
  try {
    res = await postSynth(
      { project: ir.app.name, stage: ir.app.stage, artifact: "cloudformation", ir, assets },
      apiKey,
      config.projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(`Synth failed — ${err.message}`);
    throw err;
  }
  if (res.artifact !== "cloudformation") {
    throw new Error("Server returned a CDK project; expected a CloudFormation template to deploy.");
  }

  assembleFromTemplate({
    outdir: cdkOutDir,
    stackName: res.stackName,
    template: res.template,
    handlers,
    region: env.region ?? config.region,
    account: env.account,
  });

  return {
    ir,
    stackName: res.stackName,
    cdkOutDir,
    region: env.region ?? config.region,
    deploymentId: res.deploymentId,
  };
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
