import { Toolkit, StackSelectionStrategy } from "@aws-cdk/toolkit-lib";
import { loadConfig, resolveApiKey } from "@alzulejos/laranja-core";
import { buildPlanAssembly } from "../pipeline.js";
import { usesWebpackBuilder } from "../nest-build.js";
import { getAccountId } from "../aws.js";
import { applyAwsEnv, requireRegion } from "../io.js";
import { summarizePlan, type StackDiffView } from "../plan-summary.js";
import * as ui from "../ui.js";

/** Swallows the toolkit's own diff output — we render our own summary instead. */
const silentIoHost = {
  async notify(): Promise<void> {},
  async requestResponse<T>(msg: { defaultResponse: T }): Promise<T> {
    return msg.defaultResponse;
  },
};

/**
 * Show what a deploy would do: synthesize the template on the laranja server
 * (read-only — no deployment row, no quota), diff it against the stack currently
 * deployed in your AWS account, and print the laranja table with each resource
 * tagged created / changed / unchanged. Needs `LARANJA_API_KEY` (for the synth)
 * and AWS credentials (to read the live stack). Nothing is applied.
 */
export async function plan(projectDir: string, opts: { stage?: string } = {}): Promise<void> {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to plan.");

  // loadConfig raises a clear "run `laranja init`" error if this directory isn't
  // linked yet (empty name/projectId); pipeline enforces projectId before synth.
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const region = requireRegion(config.region);
  applyAwsEnv({ region, profile: config.profile });

  // The webpack builder renames the bootstrap export, which laranja resolves by
  // name — deploys against a webpacked build fail to find it. Flag it here in the
  // cheap path so it's caught before deploy. See docs → Reference → Troubleshooting.
  if (usesWebpackBuilder(projectDir)) {
    ui.warn(
      "nest-cli.json uses the webpack builder. laranja needs the tsc builder — " +
        "webpack renames the exported bootstrap function and the deploy can't find it. " +
        "Remove the webpack builder (or `--webpack`) from your build. " +
        "See https://laranja.io/docs/reference/troubleshooting#nestjs-webpack-builder",
    );
  }

  const sp = ui.spinner("diffing against your deployed stack");
  try {
    const account = await getAccountId(region);
    const { ir, stackName, cdkOutDir, template } = await buildPlanAssembly(
      projectDir,
      { region, account, stage: opts.stage },
      apiKey,
    );

    const toolkit = new Toolkit({ ioHost: silentIoHost });
    const cx = await toolkit.fromAssemblyDirectory(cdkOutDir);
    const diffs = await toolkit.diff(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS } });
    const diff = (diffs[stackName] ?? Object.values(diffs)[0]) as StackDiffView | undefined;

    sp.stop();
    summarizePlan(ir, template ?? {}, diff ?? { resources: { changes: {} } });
  } catch (err) {
    sp.fail("plan failed");
    throw err;
  }
}
