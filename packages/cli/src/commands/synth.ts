import path from "node:path";
import { readFileSync } from "node:fs";
import { buildAssembly, printPlan } from "../pipeline.js";

/** Build + synth only (no AWS calls). Useful for inspecting what would deploy. */
export async function synthCommand(projectDir: string): Promise<void> {
  const { ir, stackName, cdkOutDir } = await buildAssembly(projectDir);
  const templatePath = path.join(cdkOutDir, `${stackName}.template.json`);
  const tpl = JSON.parse(readFileSync(templatePath, "utf8")) as { Resources: Record<string, { Type: string }> };

  const counts: Record<string, number> = {};
  for (const r of Object.values(tpl.Resources)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;

  console.log(`Plan for "${stackName}":`);
  printPlan(ir);
  console.log("\nAWS resources:");
  for (const [type, count] of Object.entries(counts).sort()) {
    console.log(`  ${String(count).padStart(2)}x  ${type}`);
  }
  console.log(`\nTemplate: ${path.relative(projectDir, templatePath)}`);
}
