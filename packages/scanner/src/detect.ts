import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Framework } from "@alzulejos/laranja-core";

/** Detect the framework from the project's package.json dependencies. */
export function detectFramework(projectDir: string): Framework {
  const pkgPath = path.join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return "express";
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps["@nestjs/core"]) return "nest";
  return "express";
}
