import path from "node:path";
import { rmSync } from "node:fs";
import {
  loadConfig,
  postSynth,
  postDiff,
  ApiRequestError,
  apiErrorMessage,
  AZURE_DEFAULT_TIMEOUT_SECONDS,
  type AzureHandlerAsset,
  type InfraIR,
} from "@alzulejos/laranja-core";
import { scan } from "@alzulejos/laranja-scanner";
import { generateEntries } from "@alzulejos/laranja-runtime";
import { bundleEntries, computeAssetHashes, assembleFromTemplate } from "@alzulejos/laranja-assembly";
import { writeResourceTypes } from "./resource-types.js";
import { resolveNestCompiledEntry } from "./nest-build.js";
import { archFromTemplate, assertNativeBinariesMatch } from "./native-guard.js";
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
  const entryDir = path.join(outRoot, "entries");
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
  // Nest: point every shim at the user's COMPILED output (DI metadata intact), not
  // their .ts source — the HTTP bootstrap, the workers(AppModule) module, and each
  // class-based provider. Express bundles straight from source (all undefined).
  // Optional lazy requires that aren't installed are handled by the bundler's
  // local-parity rule (unresolvable -> external), not by us.
  const isNest = ir.app.framework === "nest";
  const httpEntry = isNest && ir.http ? resolveNestCompiledEntry(projectDir, ir.http.handlerEntry) : undefined;
  const resolveCompiled = isNest ? (file: string) => resolveNestCompiledEntry(projectDir, file) : undefined;
  const entries = generateEntries(ir, { projectDir, entryDir, httpEntry, resolveCompiled });
  const handlers = await bundleEntries(entries, {
    entryDir,
    buildDir,
    projectDir,
    provider: ir.app.provider,
    // Azure's function timeout lives in host.json, inside the package — so it
    // must be known before bundling, since the package hash is computed here.
    httpTimeoutSeconds: ir.http?.compute?.timeout ?? AZURE_DEFAULT_TIMEOUT_SECONDS,
  });
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

  // Refuse to ship native binaries that can't load on the target architecture.
  assertNativeBinariesMatch(handlers, archFromTemplate(res.template));

  step("assemble template");
  assembleFromTemplate({
    outdir: cdkOutDir,
    stackName: res.stackName,
    template: res.template,
    handlers,
    region,
    account: env.account,
  });

  return { ir, stackName: res.stackName, cdkOutDir, region, deploymentId: res.deploymentId, projectId };
}

/** An Azure deploy carries the ARM template plus where the package must go. */
export interface AzureRemoteAssembly {
  ir: InfraIR;
  template: Record<string, unknown>;
  assets: AzureHandlerAsset[];
  names: { functionApp: string; storageAccount: string; container: string };
  warnings: { code: string; message: string }[];
  /** Absolute path to each handler's bundled output dir, keyed by handler id. */
  assetDirsById: Record<string, string>;
  deploymentId: string;
  projectId: string;
}

/**
 * Server build for an Azure deploy. Same front half as AWS (scan, bundle,
 * fingerprint, `/synth`) — only the artifact differs, so the source still never
 * leaves the machine. There's no assembly step: the returned ARM template is
 * submitted directly.
 */
export async function buildAzureAssembly(
  projectDir: string,
  env: BuildEnv,
  apiKey: string,
): Promise<AzureRemoteAssembly> {
  const { projectId, ir, handlers, assets } = await prepareUpload(projectDir, env);

  step("server synth");
  let res;
  try {
    res = await postSynth(
      { project: ir.app.name, stage: ir.app.stage, artifact: "arm", ir, assets },
      apiKey,
      projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(apiErrorMessage("Synth failed", err));
    throw err;
  }
  note({ deploymentId: res.deploymentId });
  if (res.artifact !== "arm") {
    throw new Error(
      `Server returned a "${res.artifact}" artifact; expected "arm" for an Azure project.`,
    );
  }

  const assetDirsById: Record<string, string> = {};
  for (const h of handlers) assetDirsById[h.id] = h.assetDir;

  return {
    ir,
    template: res.template,
    assets: res.assets,
    names: res.names,
    warnings: res.warnings ?? [],
    assetDirsById,
    deploymentId: res.deploymentId,
    projectId,
  };
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

  // Same guard as deploy, so `plan` surfaces a doomed native binary early.
  assertNativeBinariesMatch(handlers, archFromTemplate(res.template));

  assembleFromTemplate({
    outdir: cdkOutDir,
    stackName: res.stackName,
    template: res.template,
    handlers,
    region,
    account: env.account,
  });

  return { ir, stackName: res.stackName, cdkOutDir, region, template: res.template };
}

/**
 * Server build for an Azure plan: prepare upload -> `/diff` with `artifact:
 * "arm"` (read-only, NO deployment row) -> hand back the ARM template so the CLI
 * can run it through ARM what-if against the live resource group.
 *
 * No assembly/upload — what-if only needs the template, and plan must never open
 * a deployment row or upload a package.
 */
export async function buildAzurePlanTemplate(
  projectDir: string,
  env: BuildEnv,
  apiKey: string,
): Promise<{ ir: InfraIR; template: Record<string, unknown> }> {
  const { projectId, ir, assets } = await prepareUpload(projectDir, env);

  let res;
  try {
    res = await postDiff(
      { project: ir.app.name, stage: ir.app.stage, artifact: "arm", ir, assets },
      apiKey,
      projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(apiErrorMessage("Plan failed", err));
    throw err;
  }
  // Back-compat: an older server omits `artifact` and only speaks CloudFormation.
  if (res.artifact !== "arm" || !res.template) {
    throw new Error(
      "The server didn't return an ARM template to preview — `laranja plan` needs an Azure-aware server.",
    );
  }
  return { ir, template: res.template };
}

/**
 * Build the Azure deployment PACKAGE locally for eject — scan + bundle, no server
 * call and no deployment row. Returns the IR and the bundled asset directory the
 * caller zips into the ejected project.
 */
export async function buildAzureEjectPackage(
  projectDir: string,
  env: BuildEnv,
): Promise<{ ir: InfraIR; assetDir: string }> {
  const { ir, handlers } = await prepareUpload(projectDir, env);
  const http = handlers.find((h) => h.id === "http");
  if (!http) throw new Error("Internal: no http handler bundled for eject.");
  return { ir, assetDir: http.assetDir };
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
