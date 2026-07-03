// Bumps every publishable package to a shared version and keeps internal
// @alzulejos/laranja-* dependency pins in lockstep. Run before merging to prod:
//   node scripts/set-version.mjs 0.2.0
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: node scripts/set-version.mjs <semver>  (e.g. 0.2.0)");
  process.exit(1);
}

const pkgsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages");

for (const name of readdirSync(pkgsDir)) {
  const file = join(pkgsDir, name, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  pkg.version = version;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith("@alzulejos/laranja")) deps[dep] = version;
    }
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${pkg.name} → ${version}`);
}
