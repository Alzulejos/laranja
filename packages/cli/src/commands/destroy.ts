import { loadConfig, stackName, resolveApiKey, postDestroy, patchDeployment } from "@alzulejos/laranja-core";
import { getAccountId, deleteStack } from "../aws.js";
import { reportSafely } from "../lifecycle.js";
import { step, note } from "../diagnostics.js";
import { applyAwsEnv, confirm, requireRegion } from "../io.js";
import * as ui from "../ui.js";

export async function destroy(projectDir: string, opts: { stage?: string } = {}): Promise<void> {
  step("load config");
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const region = requireRegion(config.region);
  applyAwsEnv({ region, profile: config.profile });

  step("resolve account");
  const account = await getAccountId(region);
  const name = stackName(config.name, config.stage);
  note({ project: config.name, stage: config.stage, region, account, stackName: name });
  ui.header(`destroy ${config.name} ${ui.dim(config.stage)} ${ui.dim("→")} ${region}`);
  ui.step("🔑", "account", account);
  ui.note(`this will DELETE the "${config.name}" (${config.stage}) stack and its resources.`);
  if (!(await confirm("     are you sure? (y/N)"))) {
    console.log("\n  aborted.\n");
    return;
  }

  // If we're logged in, open a teardown row on the dashboard and report the
  // lifecycle around the delete. The BE owns the REMOVED resource inventory, so
  // the client only sends the stack identity + status — no IR, no synth.
  const apiKey = resolveApiKey();
  let deploymentId: string | undefined;
  if (apiKey) {
    step("open teardown");
    await reportSafely("open teardown", async () => {
      deploymentId = await postDestroy(
        { stackName: name, artifact: "cloudformation", provider: "AWS", region },
        apiKey,
      );
    });
    if (deploymentId) {
      note({ deploymentId });
      await reportSafely("report start", () => patchDeployment(deploymentId!, { status: "STARTED", region }, apiKey));
    }
  }

  // No synth, local or remote — CloudFormation deletes the stack by name.
  step("delete stack");
  const sp = ui.spinner("tearing down stack");
  let existed: boolean;
  try {
    existed = await deleteStack(region, name);
    sp.succeed(existed ? "destroyed" : "nothing to destroy (no such stack)");
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
