import { Toolkit, NonInteractiveIoHost, StackSelectionStrategy } from "@aws-cdk/toolkit-lib";
import { loadConfig, resolveApiKey } from "@laranja/core";
import { buildDiffAssembly } from "../pipeline.js";
import { getAccountId } from "../aws.js";
import { applyAwsEnv, requireRegion } from "../io.js";

/** Diff the synthesized stack against what's currently deployed. */
export async function diff(projectDir: string, opts: { stage?: string } = {}): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const region = requireRegion(config.region);
  applyAwsEnv({ region, profile: config.profile });

  // The template is synthesized on the server (read-only — no deployment row).
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to diff.");

  const account = await getAccountId(region);
  const { cdkOutDir } = await buildDiffAssembly(projectDir, { region, account, stage: opts.stage }, apiKey);

  const toolkit = new Toolkit({ ioHost: new NonInteractiveIoHost() });
  const cx = await toolkit.fromAssemblyDirectory(cdkOutDir);
  await toolkit.diff(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS } });
}
