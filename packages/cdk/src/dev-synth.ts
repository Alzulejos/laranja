/**
 * Dev helper: scan -> generate shims -> bundle -> synth CloudFormation, then print
 * a resource summary. No AWS credentials required (synth only).
 *
 *   npm run synth:express
 *   tsx packages/cdk/src/dev-synth.ts <project-dir>
 */
import path from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { loadConfig, stackName } from "@laranja/core";
import { scan } from "@laranja/scanner";
import { generateEntries } from "@laranja/runtime";
import { bundleEntries } from "./bundle.js";
import { synth } from "./synth.js";

async function main() {
  const projectDir = path.resolve(process.argv[2] ?? ".");
  const outRoot = path.join(projectDir, ".laranja");
  rmSync(outRoot, { recursive: true, force: true });

  const config = await loadConfig(projectDir);
  const ir = scan({ projectDir, config });
  const entries = generateEntries(ir, { projectDir, entryDir: path.join(outRoot, "entries") });
  const handlers = await bundleEntries(entries, {
    entryDir: path.join(outRoot, "entries"),
    buildDir: path.join(outRoot, "build"),
  });
  const { templatePath } = synth(ir, handlers, {
    outdir: path.join(outRoot, "cdk.out"),
    stackName: stackName(config.name, config.stage),
    region: config.region,
  });

  const tpl = JSON.parse(readFileSync(templatePath, "utf8")) as {
    Resources: Record<string, { Type: string }>;
    Outputs?: Record<string, { Value: unknown; Description?: string }>;
  };

  const counts: Record<string, number> = {};
  for (const r of Object.values(tpl.Resources)) {
    counts[r.Type] = (counts[r.Type] ?? 0) + 1;
  }

  console.log(`Synthesized stack "${stackName(config.name, config.stage)}" (region ${config.region ?? "agnostic"})`);
  console.log(`Template: ${path.relative(projectDir, templatePath)}\n`);
  console.log("Resources:");
  for (const [type, count] of Object.entries(counts).sort()) {
    console.log(`  ${String(count).padStart(2)}x  ${type}`);
  }
  console.log("\nOutputs:");
  for (const [name, out] of Object.entries(tpl.Outputs ?? {})) {
    console.log(`  ${name}${out.Description ? ` — ${out.Description}` : ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
