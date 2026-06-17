import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import type { GeneratedEntry } from "@laranja/runtime";

/** A bundled Lambda handler ready to become a CDK asset. */
export interface BundledHandler {
  id: string;
  kind: GeneratedEntry["kind"];
  /** Absolute path to the asset directory (contains index.cjs). */
  assetDir: string;
  /** Lambda handler string, e.g. "index.handler". */
  handler: string;
}

export interface BundleOptions {
  /** Where to write the generated entry shims. */
  entryDir: string;
  /** Where to write the bundles (one subdir per handler). */
  buildDir: string;
}

/**
 * Writes the entry shims and esbuild-bundles each into its own asset directory
 * (so every Lambda zip contains only its own code — keeps cron/queue zips tiny).
 * Externalizes the AWS SDK (provided by the Lambda runtime).
 */
export async function bundleEntries(entries: GeneratedEntry[], opts: BundleOptions): Promise<BundledHandler[]> {
  mkdirSync(opts.entryDir, { recursive: true });
  for (const e of entries) {
    writeFileSync(path.join(opts.entryDir, e.fileName), e.contents);
  }

  const entryPoints: Record<string, string> = {};
  const assetNameById = new Map<string, string>();
  for (const e of entries) {
    const assetName = e.fileName.replace(/\.ts$/, "");
    assetNameById.set(e.id, assetName);
    // key "<assetName>/index" -> outdir/<assetName>/index.cjs
    entryPoints[`${assetName}/index`] = path.join(opts.entryDir, e.fileName);
  }

  await build({
    entryPoints,
    outdir: opts.buildDir,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outExtension: { ".js": ".cjs" },
    external: ["@aws-sdk/*", "aws-sdk"],
    logLevel: "warning",
  });

  return entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    assetDir: path.join(opts.buildDir, assetNameById.get(e.id)!),
    handler: `index.${e.handlerExport}`,
  }));
}
