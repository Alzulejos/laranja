import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, resolveApiKey, postEject, ApiRequestError } from "@laranja/core";
import { scan } from "@laranja/scanner";
import { writeResourceTypes } from "../resource-types.js";

/**
 * Generate a standalone, owned CDK project. The project is synthesized on the
 * laranja server (paid; the server gates entitlement and returns 403 if the
 * caller can't eject) — we just write the returned files to `infra/`.
 */
export async function eject(projectDir: string, opts: { force?: boolean; stage?: string }): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  if (!config.projectId) {
    throw new Error('Set "projectId" in laranja.config.ts (from your dashboard) to eject.');
  }
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to eject.");

  const ejectDir = path.join(projectDir, "infra");
  if (existsSync(ejectDir) && !opts.force) {
    throw new Error(`${path.relative(projectDir, ejectDir)}/ already exists. Re-run with --force to overwrite.`);
  }

  const ir = scan({ projectDir, config });
  writeResourceTypes(projectDir, ir);

  let res;
  try {
    res = await postEject(
      { project: ir.app.name, stage: ir.app.stage, artifact: "cdk", ir, assets: {} },
      apiKey,
      config.projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(`Eject failed — ${err.message}`);
    throw err;
  }

  for (const file of res.files) {
    const abs = path.join(ejectDir, file.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, file.contents);
  }

  console.log(`Ejected ${res.files.length} files to ${path.relative(projectDir, ejectDir)}/`);
  console.log("\nNext:");
  console.log("  cd infra");
  console.log("  npm install");
  console.log("  npm run deploy");
}
