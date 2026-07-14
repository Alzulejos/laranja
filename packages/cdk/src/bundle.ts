import path from "node:path";
import { mkdirSync, writeFileSync, cpSync } from "node:fs";
import type { GeneratedEntry } from "@alzulejos/laranja-runtime";

/**
 * A packaged Lambda handler ready to become a CDK asset.
 *
 * We no longer bundle with esbuild. Each handler ships as a tiny generated ESM
 * shim (`index.mjs`) plus a copy of the user's own built output — their real
 * compiled app, DI metadata intact. Third-party `node_modules` are NOT in here;
 * they ride in a shared Lambda layer, so these zips stay small and never trip over
 * a dependency's optional lazy `require()` (the whole reason we stopped bundling).
 */
export interface BundledHandler {
  id: string;
  kind: GeneratedEntry["kind"];
  /** Absolute path to the asset directory (contains index.mjs + the built output). */
  assetDir: string;
  /** Lambda handler string, e.g. "index.handler". */
  handler: string;
}

export interface BundleOptions {
  /** Where to write the per-handler asset dirs (one subdir each). */
  buildDir: string;
  /** User project root — the built output is copied from here. */
  projectDir: string;
  /**
   * The project's built-output dir, RELATIVE to `projectDir` (e.g. "dist"). The
   * whole tree is copied into each asset dir at the same relative path, so a shim's
   * `./dist/main.js` import resolves inside the deployed zip. Its own `node_modules`
   * imports resolve at runtime from the shared layer.
   */
  outDir: string;
}

/**
 * Assemble each generated shim into its own asset directory: write `index.mjs`,
 * then copy the user's built output alongside it (so every Lambda zip is
 * self-sufficient for the user's code — deps come from the layer). Returns one
 * descriptor per handler for the asset/hash/assembly steps.
 */
export function bundleEntries(entries: GeneratedEntry[], opts: BundleOptions): BundledHandler[] {
  const builtSrc = path.join(opts.projectDir, opts.outDir);
  return entries.map((e) => {
    const assetName = e.fileName.replace(/\.mjs$/, "");
    const assetDir = path.join(opts.buildDir, assetName);
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(path.join(assetDir, "index.mjs"), e.contents);
    // Preserve the outDir path so the shim's relative import lands on the copy.
    cpSync(builtSrc, path.join(assetDir, opts.outDir), { recursive: true });
    return {
      id: e.id,
      kind: e.kind,
      assetDir,
      handler: `index.${e.handlerExport}`,
    };
  });
}
