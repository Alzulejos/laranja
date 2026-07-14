import path from "node:path";
import { rmSync } from "node:fs";
import {
  loadConfig,
  postSynth,
  postDiff,
  ApiRequestError,
  apiErrorMessage,
  type InfraIR,
} from "@alzulejos/laranja-core";
import { scan } from "@alzulejos/laranja-scanner";
import { generateEntries } from "@alzulejos/laranja-runtime";
import { bundleEntries, computeAssetHashes, assembleFromTemplate } from "@alzulejos/laranja-assembly";
import { writeResourceTypes } from "./resource-types.js";
import { resolveNestCompiledEntry, resolveBuildDirs } from "./nest-build.js";
import { buildDepsLayer, type LambdaArch } from "./layer.js";
import { step, note } from "./diagnostics.js";

export interface Assembly {
  ir: InfraIR;
  stackName: string;
  /** Absolute path to the synthesized cloud assembly (cdk.out). */
  cdkOutDir: string;
  region?: string;
  /** The server-synthesized CloudFormation template (set by the plan build). */
  template?: Record<string, unknown>;
}

/** A deploy assembly also carries the dashboard deployment id to echo back. */
export interface RemoteAssembly extends Assembly {
  deploymentId: string;
  /** The validated dashboard project id (sent as `x-project-id` on lifecycle calls). */
  projectId: string;
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
  const buildDir = path.join(outRoot, "build");
  const cdkOutDir = path.join(outRoot, "cdk.out");

  rmSync(outRoot, { recursive: true, force: true });

  const config = await loadConfig(projectDir, { stage: env.stage });
  if (!config.projectId) {
    throw new Error("This project isn't linked to laranja — run `laranja init` to connect it.");
  }
  step("scan project");
  const ir = scan({ projectDir, config });
  // Attach the resolved stage now, before packaging can throw — so a pre-synth
  // failure report still carries the stage.
  note({ stage: ir.app.stage });
  writeResourceTypes(projectDir, ir);
  step("bundle handlers");
  // No bundler: every shim imports the user's BUILT output (DI metadata intact) and
  // resolves deps at runtime from the shared layer. Map each source file to its
  // compiled path — the HTTP bootstrap, the workers(AppModule) module, and each
  // class-based provider. Applies to both frameworks now (Express also needs a build,
  // since nothing transpiles at deploy time); an unbuilt project errors in codegen.
  const { outDir } = resolveBuildDirs(projectDir);
  const httpEntry = ir.http ? resolveNestCompiledEntry(projectDir, ir.http.handlerEntry) : undefined;
  const resolveCompiled = (file: string) => resolveNestCompiledEntry(projectDir, file);
  const entries = generateEntries(ir, { projectDir, httpEntry, resolveCompiled });
  const handlers = bundleEntries(entries, { buildDir, projectDir, outDir });
  const assets = computeAssetHashes(handlers);

  return { projectId: config.projectId, ir, handlers, assets, cdkOutDir, region: env.region ?? config.region };
}

/**
 * The Lambda architecture the server templated (every function shares one). Drives
 * which platform's prebuilt native deps go in the layer. Defaults to arm64.
 */
function archFromTemplate(template: Record<string, unknown>): LambdaArch {
  const resources = (template.Resources ?? {}) as Record<
    string,
    { Type?: string; Properties?: { Architectures?: string[] } }
  >;
  for (const res of Object.values(resources)) {
    if (res.Type !== "AWS::Lambda::Function") continue;
    const a = res.Properties?.Architectures?.[0];
    if (a === "x86_64" || a === "arm64") return a;
  }
  return "arm64";
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

  step("server synth");
  let res;
  try {
    res = await postSynth(
      { project: ir.app.name, stage: ir.app.stage, artifact: "cloudformation", ir, assets },
      apiKey,
      projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(apiErrorMessage("Synth failed", err));
    throw err;
  }
  // The deployment row now exists — attach its id so any later failure (assemble,
  // toolkit diff/deploy) reports against it.
  note({ deploymentId: res.deploymentId });
  if (res.artifact !== "cloudformation") {
    throw new Error("Server returned a CDK project; expected a CloudFormation template to deploy.");
  }

  step("build deps layer");
  const arch = archFromTemplate(res.template);
  const layerDir = buildDepsLayer({ projectDir, arch });

  step("assemble template");
  assembleFromTemplate({
    outdir: cdkOutDir,
    stackName: res.stackName,
    template: res.template,
    handlers,
    layerDir,
    arch,
    region,
    account: env.account,
  });

  return { ir, stackName: res.stackName, cdkOutDir, region, deploymentId: res.deploymentId, projectId };
}

/**
 * Server build for a plan: prepare upload -> `/diff` (read-only synth, NO
 * deployment row) -> assemble the returned template so the toolkit can diff it
 * against the deployed stack.
 */
export async function buildPlanAssembly(
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
    if (err instanceof ApiRequestError) throw new Error(apiErrorMessage("Plan failed", err));
    throw err;
  }
  if (!res.stackName || !res.template) {
    throw new Error("Server did not return a template to diff.");
  }

  const arch = archFromTemplate(res.template);
  const layerDir = buildDepsLayer({ projectDir, arch });

  assembleFromTemplate({
    outdir: cdkOutDir,
    stackName: res.stackName,
    template: res.template,
    handlers,
    layerDir,
    arch,
    region,
    account: env.account,
  });

  return { ir, stackName: res.stackName, cdkOutDir, region, template: res.template };
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
