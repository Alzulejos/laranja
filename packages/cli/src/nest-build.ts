import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Nest deploys reuse the user's OWN compiled build output rather than re-bundling
 * their `.ts` from source. Reason: Nest's DI reads `design:paramtypes` metadata at
 * runtime, and only the user's `tsc`/`nest build` (`emitDecoratorMetadata: true`)
 * emits it — esbuild-from-source drops it, breaking DI in the Lambda. The compiled
 * JS already has the metadata baked in, so we point the shim at that instead.
 *
 * This resolves where the user's build put the compiled entry, given the source
 * entry the scanner recorded (e.g. `src/main.ts` -> `dist/main.js`).
 */

/** Strip `//` and `/* *\/` comments so a JSONC tsconfig still parses. */
function parseJsonc(text: string): unknown {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(noLine);
}

function readJsonc(file: string): Record<string, any> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parseJsonc(readFileSync(file, "utf8")) as Record<string, any>;
  } catch {
    return undefined;
  }
}

/**
 * Detect whether the user's `nest-cli.json` selects the **webpack** builder.
 *
 * laranja packages the user's compiled entry and resolves the exported bootstrap
 * function by name. Webpack bundles the whole app into one file and scope-hoists /
 * renames identifiers, so the `bootstrap` export becomes something like `bootstrap2`
 * and the module's top-level export is emitted as a synthetic `__FUNCTION__` — the
 * name we look for no longer exists. The `tsc` builder (the Nest default) mirrors
 * each source file 1:1 and keeps the export intact, so laranja needs that layout.
 *
 * Covers the config-based signals: `compilerOptions.webpack: true`,
 * `compilerOptions.builder: "webpack"`, and `compilerOptions.builder.type: "webpack"`.
 * (The `nest build --webpack` CLI flag isn't visible from config; the build/synth
 * step catches that case by asserting the export exists.)
 *
 * Docs: https://laranja.io/docs/reference/troubleshooting#nestjs-webpack-builder
 */
export function usesWebpackBuilder(projectDir: string): boolean {
  const nestCli = readJsonc(path.join(projectDir, "nest-cli.json"));
  const co = nestCli?.compilerOptions;
  if (!co) return false;
  if (co.webpack === true) return true;
  const builder = co.builder;
  if (builder === "webpack") return true;
  if (builder && typeof builder === "object" && builder.type === "webpack") return true;
  return false;
}

/** The user's source root (default "src") and compiled out dir (default "dist"). */
export function resolveBuildDirs(projectDir: string): { sourceRoot: string; outDir: string } {
  const nestCli = readJsonc(path.join(projectDir, "nest-cli.json"));
  const tsconfig = readJsonc(path.join(projectDir, "tsconfig.json"));
  const sourceRoot = (nestCli?.sourceRoot as string) ?? "src";
  const outDir =
    (nestCli?.compilerOptions?.outDir as string) ??
    (tsconfig?.compilerOptions?.outDir as string) ??
    "dist";
  return { sourceRoot, outDir };
}

/**
 * Map a source entry the scanner found (the HTTP bootstrap, the workers module, or
 * a provider file) to the compiled file the user's build produced, and return its
 * absolute path. Works for both a plain `tsc` output tree and a webpacked single
 * `dist/main.js` (same path either way).
 *
 * Throws an actionable error if the compiled file is missing — the user must build
 * (`npm run build` / `nest build`) before deploying, so the DI metadata exists.
 */
export function resolveNestCompiledEntry(projectDir: string, sourceEntry: string): string {
  const { sourceRoot, outDir } = resolveBuildDirs(projectDir);
  const jsEntry = sourceEntry.replace(/\.(ts|tsx|mts|cts)$/, ".js");

  // tsc mirrors each file under `outDir` at its path relative to the *computed*
  // rootDir — which is NOT necessarily `nest-cli.json`'s `sourceRoot`. tsc infers
  // rootDir as the common ancestor of all compiled files, so a single `.ts` outside
  // `src` widens it to the project root. laranja projects always have a root-level
  // `laranja.config.ts`, so `src/main.ts` typically lands at `dist/src/main.js`, not
  // `dist/main.js`. Check both layouts (existence disambiguates; `deleteOutDir`
  // leaves only the real one). A webpacked single-file build is the first candidate.
  const candidates = [
    // rootDir === sourceRoot  ->  dist/main.js
    path.join(outDir, path.relative(sourceRoot, jsEntry)),
    // rootDir === projectDir  ->  dist/src/main.js
    path.join(outDir, jsEntry),
  ];
  for (const rel of candidates) {
    const abs = path.join(projectDir, rel);
    if (existsSync(abs)) return abs;
  }
  throw new Error(
    `Nest build output not found (looked for ${candidates.join(" and ")}). ` +
      `Build your app first (e.g. \`npm run build\`) so laranja can package the ` +
      `compiled output — Nest's dependency injection needs the metadata your build emits.`,
  );
}
