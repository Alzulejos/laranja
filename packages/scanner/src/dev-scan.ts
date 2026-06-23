/**
 * Dev helper: scan a project and print its Infra IR.
 *   npm run scan:express
 *   tsx packages/scanner/src/dev-scan.ts <project-dir>
 */
import path from "node:path";
import { loadConfig } from "@alzulejos/laranja-core";
import { scan } from "./scan.js";

async function main() {
  const dir = path.resolve(process.argv[2] ?? ".");
  const config = await loadConfig(dir);
  const ir = scan({ projectDir: dir, config });
  console.log(JSON.stringify(ir, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
