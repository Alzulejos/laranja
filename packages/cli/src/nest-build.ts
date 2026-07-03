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

/** The user's source root (default "src") and compiled out dir (default "dist"). */
function resolveBuildDirs(projectDir: string): { sourceRoot: string; outDir: string } {
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
 * Map the source HTTP entry the scanner found to the compiled file the user's
 * build produced, and return its absolute path. Works for both a plain `tsc`
 * output tree and a webpacked single `dist/main.js` (same path either way).
 *
 * Throws an actionable error if the compiled file is missing — the user must build
 * (`npm run build` / `nest build`) before deploying, so the DI metadata exists.
 */
export function resolveNestHttpEntry(projectDir: string, sourceEntry: string): string {
  const { sourceRoot, outDir } = resolveBuildDirs(projectDir);
  // src/main.ts -> main.ts -> dist/main.js
  const relFromSource = path.relative(sourceRoot, sourceEntry);
  const compiledRel = path.join(outDir, relFromSource).replace(/\.(ts|tsx|mts|cts)$/, ".js");
  const abs = path.join(projectDir, compiledRel);
  if (!existsSync(abs)) {
    throw new Error(
      `Nest build output not found at ${compiledRel}. Build your app first ` +
        `(e.g. \`npm run build\`) so laranja can package the compiled output — ` +
        `Nest's dependency injection needs the metadata your build emits.`,
    );
  }
  return abs;
}
