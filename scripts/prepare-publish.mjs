// CI-only: rewrites each package's entry points from ./src/*.ts (the dev/test
// workspace setup) to the built ./dist/*.js + .d.ts that consumers actually use.
// Runs on the ephemeral CI checkout right before `npm publish` — never committed.
// Packages already pointing at ./dist (e.g. docs) are left untouched.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";

const root = pathJoin(dirname(fileURLToPath(import.meta.url)), "..");
const pkgsDir = pathJoin(root, "packages");

const toDist = (p) => p.replace("/src/", "/dist/").replace(/\.ts$/, ".js");
const toDts = (p) => p.replace("/src/", "/dist/").replace(/\.ts$/, ".d.ts");

const rewriteExports = (exports) => {
  if (typeof exports === "string") {
    return exports.startsWith("./src/")
      ? { types: toDts(exports), default: toDist(exports) }
      : exports;
  }
  const out = {};
  for (const [key, val] of Object.entries(exports)) {
    out[key] =
      typeof val === "string" && val.startsWith("./src/")
        ? { types: toDts(val), default: toDist(val) }
        : val;
  }
  return out;
};

for (const name of readdirSync(pkgsDir)) {
  const file = pathJoin(pkgsDir, name, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  if (typeof pkg.main !== "string" || !pkg.main.startsWith("./src/")) continue;

  pkg.main = toDist(pkg.main);
  if (pkg.types) pkg.types = toDts(pkg.types);
  if (pkg.module) pkg.module = toDist(pkg.module);
  if (pkg.exports) pkg.exports = rewriteExports(pkg.exports);

  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`prepared ${pkg.name} → ${pkg.main}`);
}
