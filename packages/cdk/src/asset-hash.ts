import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { App, Stack } from "aws-cdk-lib";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import type { HandlerAssetHashes } from "@alzulejos/laranja-core";
import type { BundledHandler } from "./bundle.js";

/**
 * Compute each handler's CDK asset hash, keyed by handler id.
 *
 * We read CDK's own `Asset.assetHash` rather than hashing the zip ourselves: CDK
 * fingerprints the SOURCE (zips aren't byte-reproducible), and any hash we invent
 * is ignored/rewritten by the toolkit at deploy time. Reading it through a real
 * `Asset` guarantees the value matches exactly what the toolkit will upload —
 * `<hash>.zip` in the bootstrap bucket — which is the key the server embeds into
 * the template. If the two disagree, the Lambdas point at code never uploaded.
 *
 * Construction (not synth) computes the fingerprint, so we never call
 * `app.synth()`; staging only ever touches a throwaway temp dir.
 */
export function computeAssetHashes(handlers: BundledHandler[]): HandlerAssetHashes {
  const outdir = mkdtempSync(path.join(os.tmpdir(), "laranja-assethash-"));
  const app = new App({ outdir });
  const stack = new Stack(app, "LaranjaAssetHash");

  const hashes: HandlerAssetHashes = {};
  handlers.forEach((h, i) => {
    const asset = new Asset(stack, `Asset${i}`, { path: h.assetDir });
    hashes[h.id] = asset.assetHash;
  });
  return hashes;
}
