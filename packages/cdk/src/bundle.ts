import path from "node:path";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { build, type Plugin } from "esbuild";
import type { GeneratedEntry } from "@alzulejos/laranja-runtime";
import type { Framework } from "@alzulejos/laranja-core";

/**
 * Optional Nest peer packages a plain HTTP proxy never loads (alternate transports
 * + the Fastify platform). Nest lazy-requires these, so marking them external keeps
 * esbuild from resolving/bundling transports the deployed REST app doesn't use.
 */
const NEST_TRANSPORT_EXTERNALS = [
  "@nestjs/microservices",
  "@nestjs/websockets",
  "@nestjs/platform-fastify",
  "@nestjs/platform-socket.io",
  "@fastify/*",
];

/**
 * Peers that `@nestjs/common` `require()`s eagerly (validation.pipe /
 * class-serializer reference class-validator + class-transformer) but only USES
 * lazily. esbuild resolves those static requires at bundle time and fails when
 * they aren't installed. We can't blanket-externalize them: an app that DOES use
 * `ValidationPipe` needs them bundled. So we resolve per-build — bundle when
 * installed, stub to an empty module when not (Nest's own loadPackage wraps the
 * require, so an unused stub is harmless).
 */
const NEST_OPTIONAL_PEERS = ["class-transformer", "class-validator"];

/**
 * esbuild plugin: for `NEST_OPTIONAL_PEERS`, if the package resolves from the
 * user's project, let esbuild bundle it normally; otherwise resolve it to an empty
 * module so the bundle succeeds. Scoped to those exact packages (and their
 * subpaths) — nothing else is touched.
 */
function nestOptionalPeersPlugin(projectDir: string): Plugin {
  const req = createRequire(path.join(projectDir, "noop.js"));
  const escaped = NEST_OPTIONAL_PEERS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const filter = new RegExp(`^(${escaped.join("|")})(/|$)`);
  return {
    name: "nest-optional-peers",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter }, (args) => {
        try {
          req.resolve(args.path);
          return undefined; // installed -> bundle normally
        } catch {
          return { path: args.path, namespace: "nest-optional-empty" };
        }
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "nest-optional-empty" }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));
    },
  };
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
  /**
   * Target framework. For "nest" the HTTP shim points at the user's COMPILED
   * output, and we externalize Nest's optional transports + resolve its optional
   * validation peers per-build.
   */
  framework?: Framework;
  /** User project root — used to resolve Nest's optional peers. Defaults from entryDir. */
  projectDir?: string;
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

  const external = ["@aws-sdk/*", "aws-sdk"];
  const plugins: Plugin[] = [];
  if (opts.framework === "nest") {
    external.push(...NEST_TRANSPORT_EXTERNALS);
    // entryDir is <projectDir>/.laranja/entries by convention; fall back up from it.
    const projectDir = opts.projectDir ?? path.resolve(opts.entryDir, "..", "..");
    plugins.push(nestOptionalPeersPlugin(projectDir));
  }

  await build({
    entryPoints,
    outdir: opts.buildDir,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outExtension: { ".js": ".cjs" },
    external,
    plugins,
    logLevel: "warning",
  });

  return entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    assetDir: path.join(opts.buildDir, assetNameById.get(e.id)!),
    handler: `index.${e.handlerExport}`,
  }));
}
