import path from "node:path";
import { rmSync } from "node:fs";
import {
  loadConfig,
  postSynth,
  postDiff,
  ApiRequestError,
  type InfraIR,
} from "@laranja/core";
import { scan } from "@laranja/scanner";
import { generateEntries } from "@laranja/runtime";
import { bundleEntries, computeAssetHashes, assembleFromTemplate } from "@laranja/cdk";

export interface Assembly {
  ir: InfraIR;
  stackName: string;
  /** Absolute path to the synthesized cloud assembly (cdk.out). */
  cdkOutDir: string;
  region?: string;
}

/** A deploy assembly also carries the dashboard deployment id to echo back. */
export interface RemoteAssembly extends Assembly {
  deploymentId: string;
}

interface BuildEnv {
  region?: string;
  account?: string;
  stage?: string;
}

/**
 * Scan -> generate shims -> bundle -> fingerprint, into ephemeral `.laranja/`.
 * Synth happens on the laranja SERVER, never here — we bundle locally only to
 * fingerprint each handler (so the server template's `<hash>.zip` keys match) and
 * to have the zips on hand for the toolkit to upload. The source never leaves the
 * machine; only the IR + hashes cross the wire.
 */
async function prepareUpload(projectDir: string, env: BuildEnv) {
  const outRoot = path.join(projectDir, ".laranja");
  const entryDir = path.join(outRoot, "entries");
  const buildDir = path.join(outRoot, "build");
  const cdkOutDir = path.join(outRoot, "cdk.out");

  rmSync(outRoot, { recursive: true, force: true });

  const config = await loadConfig(projectDir, { stage: env.stage });
  if (!config.projectId) {
    throw new Error('Set "projectId" in laranja.config.ts (from your dashboard) to use the laranja server.');
  }
  const ir = scan({ projectDir, config });
  const entries = generateEntries(ir, { projectDir, entryDir });
  const handlers = await bundleEntries(entries, { entryDir, buildDir });
  const assets = computeAssetHashes(handlers);

  return { projectId: config.projectId, ir, handlers, assets, cdkOutDir, region: env.region ?? config.region };
}

/**
 * Server build for a deploy: prepare upload -> `/synth` (opens a deployment row)
 * -> assemble the returned template into a deployable cloud assembly.
 */
export async function buildRemoteAssembly(
  projectDir: string,
  env: BuildEnv,
  apiKey: string,
): Promise<RemoteAssembly> {
  const { projectId, ir, handlers, assets, cdkOutDir, region } = await prepareUpload(projectDir, env);

  let res;
  try {
    res = await postSynth(
      { project: ir.app.name, stage: ir.app.stage, artifact: "cloudformation", ir, assets },
      apiKey,
      projectId,
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
    region,
    account: env.account,
  });

  return { ir, stackName: res.stackName, cdkOutDir, region, deploymentId: res.deploymentId };
}

/**
 * Server build for a diff: prepare upload -> `/diff` (read-only synth, NO
 * deployment row) -> assemble the returned template so the toolkit can diff it
 * against the deployed stack.
 */
export async function buildDiffAssembly(
  projectDir: string,
  env: BuildEnv,
  apiKey: string,
): Promise<Assembly> {
  const { projectId, ir, handlers, assets, cdkOutDir, region } = await prepareUpload(projectDir, env);

  let res;
  try {
    res = await postDiff(
      { project: ir.app.name, stage: ir.app.stage, artifact: "cloudformation", ir, assets },
      apiKey,
      projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(`Diff failed — ${err.message}`);
    throw err;
  }
  if (!res.stackName || !res.template) {
    throw new Error("Server did not return a template to diff.");
  }

  assembleFromTemplate({
    outdir: cdkOutDir,
    stackName: res.stackName,
    template: res.template,
    handlers,
    region,
    account: env.account,
  });

  return { ir, stackName: res.stackName, cdkOutDir, region };
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
