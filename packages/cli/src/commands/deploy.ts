import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Toolkit, StackSelectionStrategy, BootstrapEnvironments } from "@aws-cdk/toolkit-lib";
import { handlerLabel, loadConfig } from "@laranja/core";
import { buildAssembly } from "../pipeline.js";
import { getAccountId, isBootstrapped } from "../aws.js";
import { applyAwsEnv, confirm, requireRegion } from "../io.js";
import { LaranjaIoHost, makeActivityHandler } from "../iohost.js";
import * as ui from "../ui.js";

export async function deploy(
  projectDir: string,
  opts: { verbose?: boolean; stage?: string; strict?: boolean } = {},
): Promise<void> {
  const started = Date.now();
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const region = requireRegion(config.region);
  applyAwsEnv({ region, profile: config.profile });

  ui.header(`deploy ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} ${region}`);

  const account = await getAccountId(region);
  ui.step("🔑", "account", account);

  const { ir, stackName, cdkOutDir, missingEnv } = await buildAssembly(projectDir, {
    region,
    account,
    stage: opts.stage,
  });
  const lambdaCount = (ir.http ? 1 : 0) + ir.crons.length + ir.queues.length;
  const routesLabel = ir.http ? `${ir.http.routes.length} routes` : "no http";
  ui.step("📦", "build", `${routesLabel} · ${ir.crons.length} crons · ${ir.queues.length} queues → ${lambdaCount} λ`);

  // env("...") keys with no value locally/in CI. --strict fails before we deploy;
  // otherwise we deploy and warn at the end (laranja speeds you up, not babysits).
  if (missingEnv.length && opts.strict) {
    throw new Error(
      `Missing values for env declared in code: ${missingEnv.join(", ")}.\n` +
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

  const outputsFile = path.join(projectDir, ".laranja", "outputs.json");
  const sp = ui.spinner("deploying stack");
  ioHost.onActivity = opts.verbose ? undefined : makeActivityHandler(sp);
  try {
    const cx = await toolkit.fromAssemblyDirectory(cdkOutDir);
    await toolkit.deploy(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS }, outputsFile });
    sp.succeed(`deployed in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    sp.fail("deploy failed");
    throw err;
  }

  if (existsSync(outputsFile)) {
    const outputs = JSON.parse(readFileSync(outputsFile, "utf8")) as Record<string, Record<string, string>>;
    const out = outputs[stackName] ?? {};
    console.log();
    if (out.HttpUrl) ui.step("🌐", "http", out.HttpUrl);
    if (ir.crons.length) {
      ui.step("⏰", "cron", ir.crons.map((c) => handlerLabel(c)).join(", "));
    }
    if (ir.queues.length) ui.step("📨", "queue", ir.queues.map((q) => q.name).join(", "));
  }

  if (missingEnv.length) {
    console.log();
    ui.warn(`deployed without values for: ${missingEnv.join(", ")}`);
    ui.note("these env vars weren't set locally/in CI — set them and re-run deploy to populate them.");
  }

  console.log(`\n  ${ui.orange("✨ live")}  ${ui.dim(opts.verbose ? "" : "(run with --verbose for full CDK output)")}\n`);
}
