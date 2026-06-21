import { App } from "aws-cdk-lib";
import type { InfraIR } from "@laranja/core";
import { LaranjaStack } from "./stack.js";
import type { BundledHandler } from "./bundle.js";

export interface SynthOptions {
  /** Directory to write the cloud assembly (cdk.out). */
  outdir: string;
  /** CloudFormation stack name. */
  stackName: string;
  region?: string;
  account?: string;
  /**
   * Client-resolved values for the code-discovered `env("NAME")` keys
   * (name -> value). Injected into every Lambda; never part of the IR.
   */
  runtimeEnv?: Record<string, string>;
}

export interface SynthResult {
  app: App;
  /** Absolute path to the synthesized CloudFormation template. */
  templatePath: string;
}

/** Build the CDK app from an IR + bundled handlers and synth it to `outdir`. */
export function synth(ir: InfraIR, handlers: BundledHandler[], opts: SynthOptions): SynthResult {
  const app = new App({ outdir: opts.outdir });
  new LaranjaStack(app, opts.stackName, {
    ir,
    handlers,
    runtimeEnv: opts.runtimeEnv,
    // Leave env undefined for an environment-agnostic stack when no account is
    // known (lets us synth without credentials).
    env: opts.region || opts.account ? { account: opts.account, region: opts.region } : undefined,
  });
  const assembly = app.synth();
  const stack = assembly.getStackByName(opts.stackName);
  return { app, templatePath: stack.templateFullPath };
}
