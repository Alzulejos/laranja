import { Toolkit, NonInteractiveIoHost, StackSelectionStrategy } from "@aws-cdk/toolkit-lib";
import { loadConfig } from "@laranja/core";
import { buildAssembly } from "../pipeline.js";
import { getAccountId } from "../aws.js";
import { applyAwsEnv, requireRegion } from "../io.js";

/** Diff the synthesized stack against what's currently deployed. */
export async function diff(projectDir: string, opts: { stage?: string } = {}): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const region = requireRegion(config.region);
  applyAwsEnv({ region, profile: config.profile });

  const account = await getAccountId(region);
  const { cdkOutDir } = await buildAssembly(projectDir, { region, account, stage: opts.stage });

  const toolkit = new Toolkit({ ioHost: new NonInteractiveIoHost() });
  const cx = await toolkit.fromAssemblyDirectory(cdkOutDir);
  await toolkit.diff(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS } });
}
