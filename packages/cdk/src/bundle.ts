import path from "node:path";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { build, type Plugin } from "esbuild";
import type { GeneratedEntry } from "@alzulejos/laranja-runtime";
import {
  AZURE_DEFAULT_TIMEOUT_SECONDS,
  buildAzureHostJson,
  type CloudProvider,
} from "@alzulejos/laranja-core";

/**
 * Version range declared in the generated Azure `package.json`. Kept in step
 * with `@alzulejos/laranja-runtime`'s own dependency — the shim is bundled
 * against that copy, so a wide drift here would install a second one.
 */
const AZURE_FUNCTIONS_RANGE = "^4.16.2";

/**
 * LOCAL PARITY: the one rule that makes bundling arbitrary user code safe.
 *
 * Libraries routinely lazy-`require()` optional peers they only use behind a
 * config branch (TypeORM's `expo-sqlite`, Nest's `@nestjs/microservices`,
 * `class-validator`, ...). esbuild resolves statically and would fail on every
 * one that isn't installed — even though the user's app runs fine locally.
 *
 * The key observation: a module that doesn't resolve on the user's machine cannot
 * be needed at runtime, BECAUSE THE APP ALREADY RUNS LOCALLY WITHOUT IT — if that
 * `require` ever executed, it would crash locally too. So:
 *
 *   - resolves locally  -> let esbuild bundle it (it's really there, really used)
 *   - doesn't resolve   -> mark it external. At runtime the `require` throws
 *     MODULE_NOT_FOUND exactly as it would on the user's machine, and the
 *     library's own try/catch handles it exactly as it does locally.
 *
 * No package lists, no stubs, no per-library knowledge: deployed behavior is the
 * developer's own environment's behavior. This subsumes the old Nest transport
 * externals and optional-peer stubbing.
 *
 * NATIVE ADDONS: a package that resolves but ships a compiled `.node` binary
 * can't be inlined into a JS bundle. Those are marked external too, recorded, and
 * copied (with their production dependency closure) into the handler's
 * `node_modules` — the binary being correct for Lambda (Linux, matching arch) is
 * the user's build environment's job, and the CLI verifies it post-synth.
 */
function localParityPlugin(projectDir: string, natives: Map<string, string>): Plugin {
  const resolveCache = new Map<string, string | undefined>();
  const nativeCache = new Map<string, boolean>();

  /** Resolve a bare specifier the way Node would from `fromDir`; undefined if it can't. */
  const tryResolve = (spec: string, fromDir: string): string | undefined => {
    const key = `${fromDir}\0${spec}`;
    if (resolveCache.has(key)) return resolveCache.get(key);
    let resolved: string | undefined;
    try {
      resolved = createRequire(path.join(fromDir, "noop.js")).resolve(spec);
    } catch {
      resolved = undefined;
    }
    resolveCache.set(key, resolved);
    return resolved;
  };

  return {
    name: "local-parity",
    setup(pluginBuild) {
      // Bare specifiers only (not "./x", "../x", "/abs"); builtins resolve fine and
      // fall through to esbuild's own platform=node handling.
      pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
        const fromDir = args.resolveDir || projectDir;
        const resolved = tryResolve(args.path, fromDir);
        if (resolved === undefined) return { path: args.path, external: true };
        if (!resolved.includes(`${path.sep}node_modules${path.sep}`)) return undefined; // builtin
        const pkgName = packageName(args.path);
        const pkgRoot = packageRoot(resolved, pkgName);
        if (pkgRoot && isNativePackage(pkgRoot, nativeCache)) {
          natives.set(pkgName, pkgRoot);
          return { path: args.path, external: true };
        }
        return undefined; // installed, pure JS -> bundle
      });
    },
  };
}

/** "pg" from "pg/lib/x", "@scope/name" from "@scope/name/sub". */
function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The installed package's root dir, derived from a resolved file inside it. */
function packageRoot(resolvedFile: string, pkgName: string): string | undefined {
  const needle = path.join("node_modules", ...pkgName.split("/")) + path.sep;
  const idx = resolvedFile.lastIndexOf(needle);
  if (idx === -1) return undefined;
  return resolvedFile.slice(0, idx + needle.length - 1);
}

/** Does this installed package ship a compiled addon? (binding.gyp / prebuilds / *.node) */
function isNativePackage(pkgRoot: string, cache: Map<string, boolean>): boolean {
  const hit = cache.get(pkgRoot);
  if (hit !== undefined) return hit;
  const result =
    existsSync(path.join(pkgRoot, "binding.gyp")) ||
    existsSync(path.join(pkgRoot, "prebuilds")) ||
    hasDotNodeFile(pkgRoot, 3);
  cache.set(pkgRoot, result);
  return result;
}

function hasDotNodeFile(dir: string, depth: number): boolean {
  if (depth === 0) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".node")) return true;
    if (e.isDirectory() && e.name !== "node_modules" && hasDotNodeFile(path.join(dir, e.name), depth - 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Copy each externalized native package — plus its production dependency closure
 * (a native addon often needs runtime helpers, e.g. bcrypt -> @mapbox/node-pre-gyp)
 * — into `<assetDir>/node_modules`, so the deployed zip resolves them like the
 * user's machine does. Missing optional deps are skipped: local parity again.
 */
function copyNativeClosure(natives: Map<string, string>, assetDir: string): void {
  const copied = new Set<string>();
  const queue: Array<[string, string]> = [...natives];
  while (queue.length > 0) {
    const [name, root] = queue.shift()!;
    if (copied.has(name)) continue;
    copied.add(name);
    cpSync(root, path.join(assetDir, "node_modules", ...name.split("/")), { recursive: true });
    let pkg: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const req = createRequire(path.join(root, "noop.js"));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      if (copied.has(dep)) continue;
      try {
        const depRoot = packageRoot(req.resolve(dep.endsWith("/") ? dep : `${dep}/package.json`), dep);
        if (depRoot) queue.push([dep, depRoot]);
      } catch {
        // Doesn't resolve locally -> can't be needed at runtime either.
      }
    }
  }
}

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
  /** User project root — resolution baseline for the local-parity rule. */
  projectDir: string;
  /**
   * Target cloud; decides the asset LAYOUT (not the bundling itself). Lambda
   * loads a bare `index.cjs` from the zip, but the Azure Functions host expects
   * a project it can detect — see `writeAzurePackageFiles`. Defaults to "aws".
   */
  provider?: CloudProvider;
  /** Resolved HTTP timeout in seconds — Azure only, lands in host.json. */
  httpTimeoutSeconds?: number;
}

/**
 * The files an Azure Functions deployment package needs beside the bundle.
 *
 * ⚠️ Both MUST be at the ZIP ROOT. If the zip has a parent folder
 * (`project/host.json`), the Functions host detects NO FUNCTIONS AT ALL — it
 * doesn't error, it just serves nothing. That silent failure is why this is
 * centralised here and pinned by a test.
 *
 * `main` tells the host which file registers functions. Everything the user's
 * app imports is already esbuild-inlined, so the only declared dependency is the
 * Functions library itself.
 *
 * `host.json` carries the function TIMEOUT, which is not an ARM property — see
 * `buildAzureHostJson` in core for why it is built client-side.
 */
function writeAzurePackageFiles(assetDir: string, timeoutSeconds: number): void {
  const pkg = {
    name: "laranja-function",
    private: true,
    // CommonJS: esbuild emits `format: "cjs"`, and omitting "type" keeps .js CJS.
    main: "index.js",
    dependencies: { "@azure/functions": AZURE_FUNCTIONS_RANGE },
  };
  writeFileSync(path.join(assetDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    path.join(assetDir, "host.json"),
    `${JSON.stringify(buildAzureHostJson(timeoutSeconds), null, 2)}\n`,
  );
}

/**
 * Writes the entry shims and esbuild-bundles each into its own asset directory
 * (so every Lambda zip contains only its own code — keeps cron/queue zips tiny).
 * Externalizes the AWS SDK (provided by the Lambda runtime); everything else is
 * governed by the local-parity rule above. Nest shims point at the user's
 * COMPILED output, so the DI metadata their build emitted survives bundling.
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

  const isAzure = opts.provider === "azure";
  const natives = new Map<string, string>();
  await build({
    entryPoints,
    outdir: opts.buildDir,
    bundle: true,
    platform: "node",
    // Flex Consumption runs Node 22; Lambda runs 20.
    target: isAzure ? "node22" : "node20",
    format: "cjs",
    // Azure resolves the entry through package.json `main`, which must point at
    // a real file — so emit `index.js` there (still CJS, since the generated
    // package.json omits "type"). Lambda is handed `index.cjs` directly.
    ...(isAzure ? {} : { outExtension: { ".js": ".cjs" } }),
    // The Lambda runtime PROVIDES the AWS SDK, so excluding it keeps zips small.
    // Nothing provides it on Azure: anything imported must be in the bundle.
    external: isAzure ? [] : ["@aws-sdk/*", "aws-sdk"],
    plugins: [localParityPlugin(opts.projectDir, natives)],
    logLevel: "warning",
  });

  return entries.map((e) => {
    const assetDir = path.join(opts.buildDir, assetNameById.get(e.id)!);
    // Ship externalized native packages next to the bundle that requires them.
    if (natives.size > 0) copyNativeClosure(natives, assetDir);
    // Azure packages are a project the host inspects, not a bare file.
    if (isAzure) {
      writeAzurePackageFiles(assetDir, opts.httpTimeoutSeconds ?? AZURE_DEFAULT_TIMEOUT_SECONDS);
    }
    return {
      id: e.id,
      kind: e.kind,
      assetDir,
      // Azure shims register with the host instead of exporting a symbol (empty
      // handlerExport), so there's no `file.export` handler to report.
      handler: e.handlerExport ? `index.${e.handlerExport}` : "",
    };
  });
}
