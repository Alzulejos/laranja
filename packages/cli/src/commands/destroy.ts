import { Toolkit, StackSelectionStrategy } from "@aws-cdk/toolkit-lib";
import { loadConfig, stackName, resolveApiKey, postDestroy, patchDeployment } from "@laranja/core";
import { buildAssembly } from "../pipeline.js";
import { getAccountId } from "../aws.js";
import { reportSafely } from "../lifecycle.js";
import { applyAwsEnv, confirm, requireRegion } from "../io.js";
import { LaranjaIoHost, makeActivityHandler } from "../iohost.js";
import * as ui from "../ui.js";

export async function destroy(projectDir: string, opts: { verbose?: boolean; stage?: string } = {}): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const region = requireRegion(config.region);
  applyAwsEnv({ region, profile: config.profile });

  const account = await getAccountId(region);
  const name = stackName(config.name, config.stage);
  ui.header(`destroy ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} ${region}`);
  ui.step("🔑", "account", account);
  ui.note(`this will DELETE the "${config.name}" (${config.stage}) stack and its resources.`);
  if (!(await confirm("     are you sure? (y/N)"))) {
    console.log("\n  aborted.\n");
    return;
  }

  // If we're logged in, open a teardown row on the dashboard and report the
  // lifecycle around the delete. The BE owns the REMOVED resource inventory, so
  // the client only sends the stack identity + status — no IR needed.
  const apiKey = resolveApiKey();
  let deploymentId: string | undefined;
  if (apiKey) {
    await reportSafely("open teardown", async () => {
      deploymentId = await postDestroy(
        { stackName: name, artifact: "cloudformation", provider: "AWS", region },
        apiKey,
      );
    });
    if (deploymentId) {
      await reportSafely("report start", () => patchDeployment(deploymentId!, { status: "STARTED", region }, apiKey));
    }
  }

  const { cdkOutDir } = await buildAssembly(projectDir, { region, account, stage: opts.stage });
  const ioHost = new LaranjaIoHost(opts.verbose);
  const toolkit = new Toolkit({ ioHost });
  const sp = ui.spinner("tearing down stack");
  ioHost.onActivity = opts.verbose ? undefined : makeActivityHandler(sp, "removing");
  try {
    const cx = await toolkit.fromAssemblyDirectory(cdkOutDir);
    await toolkit.destroy(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS } });
    sp.succeed("destroyed");
  } catch (err) {
    sp.fail("destroy failed");
    if (deploymentId) {
      await reportSafely("report failure", () => patchDeployment(deploymentId!, { status: "FAILED" }, apiKey!));
    }
    throw err;
  }

  if (deploymentId) {
    await reportSafely("report success", () => patchDeployment(deploymentId!, { status: "SUCCESS" }, apiKey!));
  }

  console.log(`\n  ${ui.orange("🧹 gone")}\n`);
}
