import os from "node:os";
import path from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * We stopped bundling `node_modules` into each handler; instead every function
 * shares ONE Lambda layer that carries the user's dependencies.
 *
 * laranja is a DEPLOYMENT tool, not a packaging tool: like AWS CDK, we ship the
 * `node_modules` the user already installed, exactly as-is. We do NOT re-install,
 * cross-compile, or second-guess native binaries — producing artifacts correct for
 * the deploy target is the user's environment's job (and in the real world that's a
 * Linux CI, where the binaries are already right). If a library lazy-`require()`s an
 * optional dependency nobody installed (e.g. TypeORM's `expo-sqlite`), that's the
 * library's/user's concern, not ours — and since we no longer bundle, it simply
 * isn't there at build time and never trips us up.
 *
 * Cached by lockfile hash so an unchanged tree isn't re-copied every `plan`.
 */

export type LambdaArch = "arm64" | "x86_64";

export interface DepsLayerOptions {
  /** User project root (holds node_modules + a lockfile). */
  projectDir: string;
  /** Target Lambda architecture — tags the LayerVersion's compatibility. */
  arch: LambdaArch;
}

/** The project's lockfile, if any — used only to key the copy cache. */
function findLockfile(projectDir: string): string | undefined {
  for (const f of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    const p = path.join(projectDir, f);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Build (or reuse from cache) the deps layer directory: a copy of the user's
 * installed `node_modules`. Returns the layer ROOT — the dir to hand to
 * `Code.fromAsset`, containing `nodejs/node_modules/...` (Lambda extracts a layer
 * to `/opt`, so Node resolves these from `/opt/nodejs/node_modules`).
 */
export function buildDepsLayer(opts: DepsLayerOptions): string {
  const nodeModules = path.join(opts.projectDir, "node_modules");
  if (!existsSync(nodeModules)) {
    throw new Error(
      `No node_modules found in ${opts.projectDir}. Install your dependencies first ` +
        `(e.g. \`npm install\`) so laranja can ship them to Lambda.`,
    );
  }

  // `v3` = layer-build version; bump when the packaging changes so stale caches drop.
  const lock = findLockfile(opts.projectDir);
  const key = createHash("sha256")
    .update(lock ? readFileSync(lock) : "")
    .update("\0v3")
    .digest("hex")
    .slice(0, 16);
  const layerDir = path.join(os.tmpdir(), "laranja-layer-cache", key);
  const marker = path.join(layerDir, ".complete");
  // Only trust the cache when a lockfile pins the tree; otherwise always re-copy.
  if (lock && existsSync(marker)) return layerDir;

  rmSync(layerDir, { recursive: true, force: true });
  const dest = path.join(layerDir, "nodejs", "node_modules");
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(nodeModules, dest, { recursive: true });
  writeFileSync(marker, "");
  return layerDir;
}
