import path from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import {
  loadConfig,
  postSynth,
  resolveApiKey,
  resolveApiUrl,
  ApiRequestError,
} from "@laranja/core";
import { scan } from "@laranja/scanner";
import { generateEntries } from "@laranja/runtime";
import { bundleEntries, computeAssetHashes } from "@laranja/cdk";
import { buildAssembly, printPlan } from "../pipeline.js";

/** Build + synth only (no AWS calls). Useful for inspecting what would deploy. */
export async function synthCommand(projectDir: string, opts: { remote?: boolean; stage?: string } = {}): Promise<void> {
  if (opts.remote) {
    await synthRemote(projectDir, opts.stage);
    return;
  }

  const { ir, stackName, cdkOutDir } = await buildAssembly(projectDir, { stage: opts.stage });
  const templatePath = path.join(cdkOutDir, `${stackName}.template.json`);
  const tpl = JSON.parse(readFileSync(templatePath, "utf8")) as { Resources: Record<string, { Type: string }> };

  const counts: Record<string, number> = {};
  for (const r of Object.values(tpl.Resources)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;

  console.log(`Plan for "${stackName}":`);
  printPlan(ir);
  console.log("\nAWS resources:");
  for (const [type, count] of Object.entries(counts).sort()) {
    console.log(`  ${String(count).padStart(2)}x  ${type}`);
  }
  console.log(`\nTemplate: ${path.relative(projectDir, templatePath)}`);
}

/**
 * Server-side synth: scan -> IR -> POST /synth -> save the returned template.
 * Phase 2a — the template references handler assets by id and is NOT yet
 * deployable (the asset seam / S3 upload lands in 2b). Proves the wire + IR.
 */
async function synthRemote(projectDir: string, stage?: string): Promise<void> {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error("Set LARANJA_API_KEY to synth on the server.");

  const config = await loadConfig(projectDir, { stage });
  if (!config.projectId) {
    throw new Error('Set "projectId" in laranja.config.ts (from your dashboard) to synth on the server.');
  }
  const ir = scan({ projectDir, config });

  console.log(`Synthesizing "${ir.app.name}" on the server (${resolveApiUrl()})…`);
  printPlan(ir);

  // Bundle each handler locally and fingerprint it with CDK's own asset hash, so
  // the server's template references the exact `<hash>.zip` the toolkit will
  // upload at deploy time. The source code never leaves the machine — only hashes.
  const outRoot = path.join(projectDir, ".laranja");
  const entries = generateEntries(ir, { projectDir, entryDir: path.join(outRoot, "entries") });
  const handlers = await bundleEntries(entries, {
    entryDir: path.join(outRoot, "entries"),
    buildDir: path.join(outRoot, "build"),
  });
  const assets = computeAssetHashes(handlers);

  let res;
  try {
    res = await postSynth(
      { project: ir.app.name, stage: ir.app.stage, artifact: "cloudformation", ir, assets },
      apiKey,
      config.projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(`Synth failed — ${err.message}`);
    throw err;
  }

  const outDir = path.join(projectDir, ".laranja");
  mkdirSync(outDir, { recursive: true });

  if (res.artifact === "cloudformation") {
    const out = path.join(outDir, `${res.stackName}.remote.template.json`);
    writeFileSync(out, JSON.stringify(res.template, null, 2));
    const count = Object.keys((res.template.Resources as Record<string, unknown>) ?? {}).length;
    console.log(`\n  ✓ CloudFormation (${count} resources) — deployment ${res.deploymentId}`);
    console.log(`  Template: ${path.relative(projectDir, out)}`);
  } else {
    for (const f of res.files) {
      const out = path.join(outDir, "infra", f.path);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, f.contents);
    }
    console.log(`\n  ✓ CDK project (${res.files.length} files) — deployment ${res.deploymentId}`);
    console.log(`  Wrote: ${path.relative(projectDir, path.join(outDir, "infra"))}`);
  }
}
