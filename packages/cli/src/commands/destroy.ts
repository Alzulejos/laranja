import { Toolkit, StackSelectionStrategy } from "@aws-cdk/toolkit-lib";
import { loadConfig } from "@laranja/core";
import { buildAssembly } from "../pipeline.js";
import { getAccountId } from "../aws.js";
import { applyAwsEnv, confirm, requireRegion } from "../io.js";
import { LaranjaIoHost, makeActivityHandler } from "../iohost.js";
import * as ui from "../ui.js";

export async function destroy(projectDir: string, opts: { verbose?: boolean } = {}): Promise<void> {
  const config = await loadConfig(projectDir);
  const region = requireRegion(config.region);
  applyAwsEnv({ region, profile: config.profile });

  const account = await getAccountId(region);
  ui.header(`destroy ${config.name} ${ui.dim("→")} ${region}`);
  ui.step("🔑", "account", account);
  ui.note(`this will DELETE the "${config.name}" stack and its resources.`);
  if (!(await confirm("     are you sure? (y/N)"))) {
    console.log("\n  aborted.\n");
    return;
  }

  const { cdkOutDir } = await buildAssembly(projectDir, { region, account });
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
    throw err;
  }
  console.log(`\n  ${ui.orange("🧹 gone")}\n`);
}
