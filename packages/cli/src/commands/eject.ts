import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, resolveApiKey, postEject, ApiRequestError, apiErrorMessage } from "@alzulejos/laranja-core";
import { scan } from "@alzulejos/laranja-scanner";
import { generateEntries } from "@alzulejos/laranja-runtime";
import { writeResourceTypes } from "../resource-types.js";
import { resolveNestCompiledEntry } from "../nest-build.js";
import { note } from "../diagnostics.js";

/**
 * Generate a standalone, owned CDK project. The project is synthesized on the
 * laranja server (paid; the server gates entitlement and returns 403 if the
 * caller can't eject) — we just write the returned files to `infra/`.
 */
export async function eject(projectDir: string, opts: { force?: boolean; stage?: string }): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  note({ project: config.name, stage: config.stage });
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

  // Generate the Lambda entry shims locally — same path as deploy (pipeline.ts).
  // Only the client can do this: a Nest worker/HTTP shim must import the user's
  // COMPILED output, and resolving those paths needs the project's filesystem +
  // build output (which the server doesn't have). The server generates everything
  // else (the CDK stack, package.json, …) and its stack references these by name.
  // Done before the paid server call so a "build first" failure costs nothing.
  const entryDir = path.join(ejectDir, "entries");
  const isNest = ir.app.framework === "nest";
  const httpEntry = isNest && ir.http ? resolveNestCompiledEntry(projectDir, ir.http.handlerEntry) : undefined;
  const resolveCompiled = isNest ? (file: string) => resolveNestCompiledEntry(projectDir, file) : undefined;
  const entries = generateEntries(ir, { projectDir, entryDir, httpEntry, resolveCompiled });

  let res;
  try {
    res = await postEject(
      { project: ir.app.name, stage: ir.app.stage, artifact: "cdk", ir, assets: {} },
      apiKey,
      config.projectId,
    );
  } catch (err) {
    if (err instanceof ApiRequestError) throw new Error(apiErrorMessage("Eject failed", err));
    throw err;
  }

  for (const file of res.files) {
    const abs = path.join(ejectDir, file.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, file.contents);
  }
  // Write the locally-generated entries the server's stack points at.
  mkdirSync(entryDir, { recursive: true });
  for (const entry of entries) {
    writeFileSync(path.join(entryDir, entry.fileName), entry.contents);
  }

  console.log(`Ejected ${res.files.length + entries.length} files to ${path.relative(projectDir, ejectDir)}/`);
  console.log("\nNext:");
  console.log("  cd infra");
  console.log("  npm install");
  console.log("  npm run deploy");
}
