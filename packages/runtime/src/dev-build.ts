/**
 * Dev helper: scan a project, generate Lambda entry shims, and smoke-bundle them
 * with esbuild to prove the decorator -> shim -> bundle path resolves end to end.
 *
 *   npm run build:express
 *   tsx packages/runtime/src/dev-build.ts <project-dir>
 */
import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { loadConfig } from "@laranja/core";
import { scan } from "@laranja/scanner";
import { generateEntries } from "./codegen.js";

async function main() {
  const projectDir = path.resolve(process.argv[2] ?? ".");
  const outRoot = path.join(projectDir, ".laranja");
  const entryDir = path.join(outRoot, "entries");
  const buildDir = path.join(outRoot, "build");

  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(entryDir, { recursive: true });

  const config = await loadConfig(projectDir);
  const ir = scan({ projectDir, config });
  const entries = generateEntries(ir, { projectDir, entryDir });

  for (const e of entries) {
    writeFileSync(path.join(entryDir, e.fileName), e.contents);
  }
  console.log(`Generated ${entries.length} entry shims:`);
  for (const e of entries) {
    console.log(`  [${e.kind.padEnd(5)}] ${e.fileName}  ->  ${e.id}`);
  }

  const result = await build({
    entryPoints: entries.map((e) => path.join(entryDir, e.fileName)),
    outdir: buildDir,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outExtension: { ".js": ".cjs" },
    external: ["@aws-sdk/*", "aws-sdk"],
    logLevel: "warning",
    metafile: true,
  });

  console.log("\nBundled (handler = <file>.handler):");
  for (const [file, out] of Object.entries(result.metafile.outputs)) {
    if (file.endsWith(".cjs")) {
      console.log(`  ${path.relative(projectDir, file)}  (${(out.bytes / 1024).toFixed(1)} KB)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
