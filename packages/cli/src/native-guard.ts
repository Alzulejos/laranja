import path from "node:path";
import { openSync, readSync, closeSync, readdirSync } from "node:fs";
import type { BundledHandler } from "@alzulejos/laranja-assembly";

/**
 * Native addons ride into the zip as-is (we ship what the user's environment
 * built — laranja is a deployment tool, not a packaging tool). But a binary built
 * on the wrong platform crashes the Lambda at import time, so before deploying we
 * verify every `.node` file in the assets is Linux ELF for the target arch and
 * fail with an actionable message instead of shipping a broken function.
 *
 * Typical happy path: CI on a Linux runner (`npm i && npx laranja deploy`) — the
 * binaries are already correct. Typical failure: deploying from macOS with a
 * native dep, or an x64 runner targeting an arm64 Lambda.
 */

export type LambdaArch = "arm64" | "x86_64";

/** ELF e_machine values for the two Lambda architectures. */
const ELF_MACHINE: Record<LambdaArch, number> = { x86_64: 0x3e, arm64: 0xb7 };

/** The Lambda architecture the server templated (every function shares one). */
export function archFromTemplate(template: Record<string, unknown>): LambdaArch {
  const resources = (template.Resources ?? {}) as Record<
    string,
    { Type?: string; Properties?: { Architectures?: string[] } }
  >;
  for (const res of Object.values(resources)) {
    if (res.Type !== "AWS::Lambda::Function") continue;
    const a = res.Properties?.Architectures?.[0];
    if (a === "x86_64" || a === "arm64") return a;
  }
  return "arm64";
}

function findDotNode(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".node")) out.push(p);
    else if (e.isDirectory()) findDotNode(p, out);
  }
}

/** "linux-x86_64" | "linux-arm64" | a human-readable non-Linux description. */
function binaryPlatform(file: string): string {
  const buf = Buffer.alloc(20);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, 20, 0);
  } finally {
    closeSync(fd);
  }
  if (buf.readUInt32BE(0) === 0x7f454c46) {
    const machine = buf.readUInt16LE(18);
    if (machine === ELF_MACHINE.x86_64) return "linux-x86_64";
    if (machine === ELF_MACHINE.arm64) return "linux-arm64";
    return `linux-unknown(0x${machine.toString(16)})`;
  }
  const magic = buf.readUInt32BE(0);
  if (magic === 0xcffaedfe || magic === 0xfeedfacf || magic === 0xcafebabe) return "macOS";
  if (buf.readUInt16LE(0) === 0x5a4d) return "Windows";
  return "unknown";
}

/**
 * Throw if any handler ships a `.node` binary that won't load on the target
 * Lambda architecture. No native addons -> no-op (the common, pure-JS case).
 */
export function assertNativeBinariesMatch(handlers: BundledHandler[], arch: LambdaArch): void {
  const files: string[] = [];
  for (const h of handlers) findDotNode(h.assetDir, files);
  if (files.length === 0) return;

  const want = `linux-${arch}`;
  const bad = files
    .map((f) => ({ file: f, platform: binaryPlatform(f) }))
    .filter((b) => b.platform !== want);
  if (bad.length === 0) return;

  const lines = bad.map((b) => `  - ${b.file} (${b.platform})`).join("\n");
  throw new Error(
    `Native addon binaries don't match the Lambda target (${want}):\n${lines}\n` +
      `laranja ships the binaries your environment installed. Install/deploy from an ` +
      `environment matching the Lambda (e.g. a Linux ${arch} CI runner), or align the ` +
      `function architecture with where you build.`,
  );
}
