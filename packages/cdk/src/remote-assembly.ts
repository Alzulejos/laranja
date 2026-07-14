import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { App, Stack, type CfnResource } from "aws-cdk-lib";
import { CfnInclude } from "aws-cdk-lib/cloudformation-include";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Architecture, Code, LayerVersion } from "aws-cdk-lib/aws-lambda";
import type { BundledHandler } from "./bundle.js";

export interface RemoteAssemblyOptions {
  /** Directory to write the cloud assembly (cdk.out) the toolkit deploys. */
  outdir: string;
  /** Stack name from the `/synth` response — must match the included template. */
  stackName: string;
  /** The server-synthesized CloudFormation template, parsed. */
  template: Record<string, unknown>;
  /** The locally bundled handlers (their dirs become the uploaded zips). */
  handlers: BundledHandler[];
  /**
   * Directory of the shared dependency layer (contains `nodejs/node_modules`).
   * Registered as a LayerVersion and attached to every Lambda in the template, so
   * the handler zips can stay tiny (just the shim + the user's built code). Omit to
   * deploy without a layer.
   */
  layerDir?: string;
  /** Target Lambda architecture — the layer must be built compatible with it. */
  arch?: "arm64" | "x86_64";
  region?: string;
  account?: string;
}

/** Attach a shared deps layer to every Lambda function the server templated. */
function attachLayer(
  stack: Stack,
  include: CfnInclude,
  template: Record<string, unknown>,
  layerDir: string,
  arch: "arm64" | "x86_64",
): void {
  const layer = new LayerVersion(stack, "DepsLayer", {
    code: Code.fromAsset(layerDir),
    compatibleArchitectures: [arch === "arm64" ? Architecture.ARM_64 : Architecture.X86_64],
  });
  const resources = (template.Resources ?? {}) as Record<string, { Type?: string; Properties?: { Layers?: unknown[] } }>;
  for (const [logicalId, res] of Object.entries(resources)) {
    if (res.Type !== "AWS::Lambda::Function") continue;
    const fn = include.getResource(logicalId) as CfnResource;
    // Preserve any layers the template already set; append ours.
    const existing = res.Properties?.Layers ?? [];
    fn.addPropertyOverride("Layers", [...existing, layer.layerVersionArn]);
  }
}

/**
 * Turn the server-synthesized CloudFormation template into a deployable cloud
 * assembly for the CDK toolkit.
 *
 * The template already references each Lambda's code as `<hash>.zip` in the
 * bootstrap bucket (the server wrote those keys from the hashes we sent). We
 * `CfnInclude` it verbatim, then register one `Asset` per bundled handler.
 * CfnInclude by itself uploads nothing; the Assets are what put each zip into
 * the stack's asset manifest so the toolkit publishes them to the exact
 * `<hash>.zip` key the template points at — the Asset recomputes the same CDK
 * SOURCE fingerprint we sent the server, so the keys line up. We write no S3
 * code ourselves; the toolkit does the upload.
 *
 * Returns the cloud-assembly directory (pass to `toolkit.fromAssemblyDirectory`).
 */
export function assembleFromTemplate(opts: RemoteAssemblyOptions): string {
  // CfnInclude reads the template from disk, so stage it to a temp file. Strip
  // the CDK synthesizer scaffolding the server emitted (the BootstrapVersion
  // parameter + CheckBootstrapVersion rule): our wrapping stack regenerates
  // these identically, and CfnInclude would otherwise collide on them.
  const template = stripSynthesizerScaffolding(opts.template);
  const templateFile = path.join(mkdtempSync(path.join(os.tmpdir(), "laranja-remote-")), "template.json");
  writeFileSync(templateFile, JSON.stringify(template));

  const app = new App({ outdir: opts.outdir });
  const stack = new Stack(app, opts.stackName, {
    stackName: opts.stackName,
    env: opts.account || opts.region ? { account: opts.account, region: opts.region } : undefined,
  });
  const include = new CfnInclude(stack, "Template", { templateFile });
  opts.handlers.forEach((h, i) => new Asset(stack, `Asset${i}`, { path: h.assetDir }));
  if (opts.layerDir) attachLayer(stack, include, template, opts.layerDir, opts.arch ?? "arm64");

  return app.synth().directory;
}

/**
 * Remove the CDK-synthesizer boilerplate a freshly wrapping stack will re-emit,
 * so `CfnInclude` doesn't collide on it. These are not user infrastructure —
 * they're the `DefaultStackSynthesizer`'s bootstrap-version guardrails, and the
 * wrapping stack adds back byte-identical copies (same CDK version + qualifier).
 * Returns a shallow copy; the input template is left untouched.
 */
function stripSynthesizerScaffolding(template: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...template };

  const params = out.Parameters as Record<string, unknown> | undefined;
  if (params?.BootstrapVersion) {
    const { BootstrapVersion, ...rest } = params;
    if (Object.keys(rest).length) out.Parameters = rest;
    else delete out.Parameters;
  }

  const rules = out.Rules as Record<string, unknown> | undefined;
  if (rules?.CheckBootstrapVersion) {
    const { CheckBootstrapVersion, ...rest } = rules;
    if (Object.keys(rest).length) out.Rules = rest;
    else delete out.Rules;
  }

  return out;
}
