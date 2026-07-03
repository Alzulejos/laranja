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

  // Destroy talks to the dashboard to open a teardown row, and that call is the
  // permission gate. Require credentials up front (and fail-closed on the gate
  // below) so nothing gets deleted unless the API authenticates and authorizes
  // us first — a missing/revoked key or an unreachable API must stop here.
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to destroy.");
  }
  const projectId = config.projectId;
  if (!projectId) {
    throw new Error("This project isn't linked to laranja — run `laranja init` before destroy.");
  }

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

  // Open the teardown row. This is the permission gate: it authenticates the API
  // key and authorizes the destroy against the project. Fail-closed — a bad or
  // revoked key, a forbidden project, or an unreachable API throws here and
  // aborts before we touch CloudFormation. The BE owns the REMOVED resource
  // inventory, so the client only sends the stack identity — no IR, no synth.
  step("open teardown");
  const deploymentId = await postDestroy(
    { stackName: name, artifact: "cloudformation", provider: "AWS", region },
    apiKey,
    projectId,
  );
  note({ deploymentId });
  await reportSafely("report start", () => patchDeployment(deploymentId, { status: "STARTED", region }, apiKey));

  // No synth, local or remote — CloudFormation deletes the stack by name.
  step("delete stack");
  const sp = ui.spinner("tearing down stack");
  let existed: boolean;
  try {
    existed = await deleteStack(region, name);
    sp.succeed(existed ? "destroyed" : "nothing to destroy (no such stack)");
  } catch (err) {
    sp.fail("destroy failed");
    await reportSafely("report failure", () => patchDeployment(deploymentId, { status: "FAILED" }, apiKey));
    throw err;
  }

  await reportSafely("report success", () => patchDeployment(deploymentId, { status: "SUCCESS" }, apiKey));

  console.log(`\n  ${ui.orange("🧹 gone")}\n`);
}
