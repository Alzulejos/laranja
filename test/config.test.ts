import { describe, test, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@alzulejos/laranja-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const example = (name: string) => path.join(here, "..", "examples", name);

describe("loadConfig", () => {
  test("applies defaults (appExport, stage, env) and leaves http unset", async () => {
    const cfg = await loadConfig(example("express-basic"));
    expect(cfg.name).toBe("express-basic");
    expect(cfg.entry).toBe("src/app.ts");
    expect(cfg.appExport).toBe("app");
    expect(cfg.stage).toBe("dev");
    expect(cfg.http).toBeUndefined();
  });

  test("supports a code-first project with no entry", async () => {
    const cfg = await loadConfig(example("express-codefirst"));
    expect(cfg.name).toBe("express-codefirst");
    expect(cfg.entry).toBeUndefined();
    // defaulted even though the config omits it
    expect(cfg.appExport).toBe("app");
  });

  test("reads an explicit http: false (workers-only)", async () => {
    const cfg = await loadConfig(example("workers-only"));
    expect(cfg.http).toBe(false);
  });

  test("throws a helpful error when no config file exists", async () => {
    await expect(loadConfig(here)).rejects.toThrow(/No laranja\.config\.ts/);
  });
});
