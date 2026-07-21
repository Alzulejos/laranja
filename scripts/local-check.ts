/**
 * laranja-check — run the LOCAL half of a deploy against a real project.
 *
 * Local development only. Never published.
 *
 * Everything up to `/synth` happens on your machine: load config, scan, generate
 * the entry shim, bundle, lay out the package, fingerprint. This runs exactly
 * that and prints what came out — no API key, no cloud credentials, no network.
 *
 * It exists because the interesting failures live here and several are SILENT:
 *   - a shim importing something the project can't resolve gets marked external
 *     by the local-parity rule, bundles cleanly, and dies at runtime
 *   - an Azure package missing host.json/package.json at its ROOT makes the
 *     Functions host detect no functions AND report no error
 *
 * The last step `require()`s the bundle, which is the only offline way to prove
 * nothing was silently externalised.
 *
 * Usage:  laranja-check [project-dir]
 */

import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { AZURE_DEFAULT_TIMEOUT_SECONDS, loadConfig } from "@alzulejos/laranja-core";
import { scan } from "@alzulejos/laranja-scanner";
import { generateEntries } from "@alzulejos/laranja-runtime";
import { bundleEntries, computeAssetHashes } from "@alzulejos/laranja-assembly";

const row = (label: string, value: string) => console.log(`  ${label.padEnd(12)} ${value}`);

async function main() {
  const projectDir = path.resolve(process.argv[2] ?? process.cwd());
  console.log(`\nlaranja-check  ${projectDir}\n`);

  const config = await loadConfig(projectDir);
  row("config", `${config.name} · ${config.stage} · provider=${config.provider}`);

  const ir = scan({ projectDir, config });
  const routes = ir.http?.routes.map((r) => `${r.method} ${r.path}`) ?? [];
  row("scan", `${routes.length} route(s), ${ir.crons.length} cron(s), ${ir.queues.length} queue(s)`);
  for (const r of routes) row("", `  ${r}`);
  if (ir.envKeys.length) row("env keys", ir.envKeys.join(", "));

  const entryDir = path.join(projectDir, ".laranja", "entries");
  const buildDir = path.join(projectDir, ".laranja", "build");
  const entries = generateEntries(ir, { projectDir, entryDir });

  console.log("\n  generated shim:");
  for (const line of entries[0].contents.trimEnd().split("\n")) console.log(`      ${line}`);

  const handlers = await bundleEntries(entries, {
    entryDir,
    buildDir,
    projectDir,
    provider: ir.app.provider,
    httpTimeoutSeconds: ir.http?.compute?.timeout ?? AZURE_DEFAULT_TIMEOUT_SECONDS,
  });

  console.log();
  const isAzure = ir.app.provider === "azure";
  for (const h of handlers) {
    row("package", `${path.basename(h.assetDir)}/  →  ${readdirSync(h.assetDir).sort().join(", ")}`);
    // Azure only: these MUST be at the asset root or the host serves nothing.
    if (isAzure) {
      const pkg = JSON.parse(readFileSync(path.join(h.assetDir, "package.json"), "utf8"));
      const host = JSON.parse(readFileSync(path.join(h.assetDir, "host.json"), "utf8"));
      row("main", String(pkg.main));
      row("timeout", String(host.functionTimeout));
    }
  }

  for (const [id, hash] of Object.entries(computeAssetHashes(handlers))) {
    row("hash", `${id} → ${hash.slice(0, 16)}…`);
  }

  // The real check: does the bundle load? A silently-externalised dependency
  // only shows up here, never at build time.
  console.log();
  const require = createRequire(import.meta.url);
  for (const h of handlers) {
    const entry = path.join(h.assetDir, isAzure ? "index.js" : "index.cjs");
    try {
      require(entry);
      console.log(`  ✅ ${path.basename(h.assetDir)} loads with no missing modules`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      console.log(`  ❌ ${path.basename(h.assetDir)} failed to load: ${e.code ?? ""} ${e.message.split("\n")[0]}`);
      process.exitCode = 1;
    }
  }
  console.log();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
