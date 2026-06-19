import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, stackName } from "@laranja/core";
import { scan } from "@laranja/scanner";
import { generateEjectProject } from "@laranja/cdk";

/**
 * License gate for paid features. STUB: accepts any non-empty LARANJA_LICENSE_KEY.
 * TODO: validate the key against the licensing API.
 */
function requireLicense(): void {
  const key = process.env.LARANJA_LICENSE_KEY;
  if (!key) {
    throw new Error(
      "`eject` is a paid feature.\n" +
        "  Set LARANJA_LICENSE_KEY to your license key to use it.\n" +
        "  (Billing isn't wired yet — this is a stub gate.)",
    );
  }
}

export async function eject(projectDir: string, opts: { force?: boolean; stage?: string }): Promise<void> {
  requireLicense();

  const config = await loadConfig(projectDir, { stage: opts.stage });
  const ir = scan({ projectDir, config });

  const ejectDir = path.join(projectDir, "infra");
  if (existsSync(ejectDir) && !opts.force) {
    throw new Error(`${path.relative(projectDir, ejectDir)}/ already exists. Re-run with --force to overwrite.`);
  }

  const files = generateEjectProject(ir, {
    projectDir,
    ejectDir,
    stackName: stackName(config.name, config.stage),
    region: config.region,
  });

  for (const file of files) {
    const abs = path.join(ejectDir, file.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, file.contents);
  }

  console.log(`Ejected ${files.length} files to ${path.relative(projectDir, ejectDir)}/`);
  console.log("\nNext:");
  console.log("  cd infra");
  console.log("  npm install");
  console.log("  npm run deploy");
}
