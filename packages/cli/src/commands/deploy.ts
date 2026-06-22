import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Toolkit, StackSelectionStrategy, StackParameters, BootstrapEnvironments } from "@aws-cdk/toolkit-lib";
import {
  envParamName,
  handlerLabel,
  loadConfig,
  patchDeployment,
  postDeploymentResources,
  resolveApiKey,
  resolveDeclaredEnv,
} from "@laranja/core";
import { buildAssembly, buildRemoteAssembly, type RemoteAssembly } from "../pipeline.js";
import { getAccountId, isBootstrapped } from "../aws.js";
import { buildDeployedResources } from "../report.js";
import { reportSafely } from "../lifecycle.js";
import { applyAwsEnv, confirm, requireRegion } from "../io.js";
import { LaranjaIoHost, makeActivityHandler } from "../iohost.js";
import * as ui from "../ui.js";

export async function deploy(
  projectDir: string,
  opts: { verbose?: boolean; stage?: string; strict?: boolean; remote?: boolean } = {},
): Promise<void> {
  const started = Date.now();
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const region = requireRegion(config.region);
  applyAwsEnv({ region, profile: config.profile });

  // For a server-side build we need the API key before touching AWS, so fail fast.
  const apiKey = opts.remote ? resolveApiKey() : undefined;
  if (opts.remote && !apiKey) {
    throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to deploy via the server.");
  }

  ui.header(`deploy ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} ${region}`);

  const account = await getAccountId(region);
  ui.step("🔑", "account", account);

  // Local build (synth on this machine) or server build (synth on the laranja
  // server; we only bundle + fingerprint locally). Both yield a cloud assembly
  // the toolkit deploys with the user's own AWS credentials.
  const built = opts.remote
    ? await buildRemoteAssembly(projectDir, { region, account, stage: opts.stage }, apiKey!)
    : await buildAssembly(projectDir, { region, account, stage: opts.stage });
  const { ir, stackName, cdkOutDir } = built;
  const lambdaCount = (ir.http ? 1 : 0) + ir.crons.length + ir.queues.length;
  const routesLabel = ir.http ? `${ir.http.routes.length} routes` : "no http";
  const where = opts.remote ? "server build" : "build";
  ui.step("📦", where, `${routesLabel} · ${ir.crons.length} crons · ${ir.queues.length} queues → ${lambdaCount} λ`);

  // A server build opened a deployment row at /synth; we report its lifecycle to
  // the dashboard (STARTED before AWS → SUCCESS/FAILED after). Local builds have
  // no dashboard deployment, so they skip reporting entirely.
  const deploymentId = opts.remote ? (built as RemoteAssembly).deploymentId : undefined;
  if (deploymentId) {
    await reportSafely("report start", () => patchDeployment(deploymentId, { status: "STARTED", region }, apiKey!));
  }

  // Resolve the code-discovered env("...") keys from this machine's process.env.
  // Values are passed to CloudFormation as stack Parameters at deploy time (never
  // baked into the template / IR). Unset keys are left unspecified, so on an
  // update CloudFormation keeps the previous value (UsePreviousValue) and on a
  // first deploy the Parameter default ("") applies.
  const { resolved, missing } = resolveDeclaredEnv(ir.envKeys);
  const envParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) envParams[envParamName(key)] = value;

  // --strict fails before we deploy; otherwise we deploy and warn at the end
  // (laranja speeds you up, it doesn't babysit).
  if (missing.length && opts.strict) {
    throw new Error(
      `Missing values for env declared in code: ${missing.join(", ")}.\n` +
        `  Set them in your shell / CI (repo secrets) and re-run, or drop --strict.`,
    );
  }

  const ioHost = new LaranjaIoHost(opts.verbose);
  const toolkit = new Toolkit({ ioHost });

  if (!(await isBootstrapped(region))) {
    ui.step("🥾", "bootstrap", "first deploy to this account/region");
    ui.note("creates a one-time S3 asset bucket + IAM roles in YOUR account");
    if (!(await confirm("     proceed? (y/N)"))) {
      console.log("\n  aborted — bootstrap later, then re-run deploy.\n");
      return;
    }
    const sp = ui.spinner("bootstrapping");
    try {
      await toolkit.bootstrap(BootstrapEnvironments.fromList([`aws://${account}/${region}`]));
      sp.succeed("bootstrapped");
    } catch (err) {
      sp.fail("bootstrap failed");
      throw err;
    }
  }

  const cx = await toolkit.fromAssemblyDirectory(cdkOutDir);

  const outputsFile = path.join(projectDir, ".laranja", "outputs.json");
  const sp = ui.spinner("deploying stack");
  ioHost.onActivity = opts.verbose ? undefined : makeActivityHandler(sp);
  try {
    await toolkit.deploy(cx, {
      stacks: { strategy: StackSelectionStrategy.ALL_STACKS },
      // Supply env values; unspecified keys keep their previous value on update.
      parameters: StackParameters.withExisting(envParams),
      outputsFile,
    });
    sp.succeed(`deployed in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    sp.fail("deploy failed");
    if (deploymentId) {
      await reportSafely("report failure", () => patchDeployment(deploymentId, { status: "FAILED" }, apiKey!));
    }
    throw err;
  }

  let out: Record<string, string> = {};
  if (existsSync(outputsFile)) {
    const outputs = JSON.parse(readFileSync(outputsFile, "utf8")) as Record<string, Record<string, string>>;
    out = outputs[stackName] ?? {};
    console.log();
    if (out.HttpUrl) ui.step("🌐", "http", out.HttpUrl);
    if (ir.crons.length) {
      ui.step("⏰", "cron", ir.crons.map((c) => handlerLabel(c)).join(", "));
    }
    if (ir.queues.length) ui.step("📨", "queue", ir.queues.map((q) => q.name).join(", "));
  }

  // Report the outcome + deployed inventory to the dashboard (success only POSTs
  // resources, per the lifecycle contract).
  if (deploymentId) {
    const resources = buildDeployedResources({ ir, region, account, outputs: out, missingEnv: missing });
    await reportSafely("report success", () => patchDeployment(deploymentId, { status: "SUCCESS" }, apiKey!));
    await reportSafely("report resources", () => postDeploymentResources(deploymentId, { resources }, apiKey!));
    ui.step("📊", "reported", `${resources.length} resource(s) → dashboard`);
  }

  if (missing.length) {
    console.log();
    ui.warn(`deployed without values for: ${missing.join(", ")}`);
    ui.note("these env vars weren't set locally/in CI — set them and re-run deploy to populate them.");
  }

  console.log(`\n  ${ui.orange("✨ live")}  ${ui.dim(opts.verbose ? "" : "(run with --verbose for full CDK output)")}\n`);
}
