import { describe, test, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@alzulejos/laranja-core";
import { makeProject, cleanupProjects } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

afterEach(cleanupProjects);

describe("loadConfig", () => {
  test("applies defaults for stage, provider, and env", async () => {
    const dir = makeProject({ "laranja.config.ts": `export default { name: "my-app" };` });
    const cfg = await loadConfig(dir);
    expect(cfg.name).toBe("my-app");
    expect(cfg.stage).toBe("dev");
    expect(cfg.provider).toBe("aws");
    expect(cfg.env).toEqual({});
  });

  test("keeps explicit values from the config file", async () => {
    const dir = makeProject({
      "laranja.config.ts": `export default { name: "api", stage: "prod", region: "eu-central-1" };`,
    });
    const cfg = await loadConfig(dir);
    expect(cfg.stage).toBe("prod");
    expect(cfg.region).toBe("eu-central-1");
  });

  test("a stage override wins over the config file", async () => {
    const dir = makeProject({ "laranja.config.ts": `export default { name: "api", stage: "prod" };` });
    const cfg = await loadConfig(dir, { stage: "staging" });
    expect(cfg.stage).toBe("staging");
  });

  test("throws a helpful error when no config file exists", async () => {
    await expect(loadConfig(here)).rejects.toThrow(/No laranja\.config\.ts/);
  });

  test("throws when name is missing", async () => {
    const dir = makeProject({ "laranja.config.ts": `export default {};` });
    await expect(loadConfig(dir)).rejects.toThrow(/"name" is required/);
  });

  test("rejects a provider other than aws", async () => {
    const dir = makeProject({
      "laranja.config.ts": `export default { name: "api", provider: "azure" };`,
    });
    await expect(loadConfig(dir)).rejects.toThrow(/only "aws" today/);
  });
});
