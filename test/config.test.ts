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

  test("rejects a provider with no back-half", async () => {
    const dir = makeProject({
      "laranja.config.ts": `export default { name: "api", provider: "gcp" };`,
    });
    await expect(loadConfig(dir)).rejects.toThrow(/"aws" or "azure" today/);
  });

  test("accepts azure when subscription and resource group are set", async () => {
    const dir = makeProject({
      "laranja.config.ts": `export default { name: "api", provider: "azure", azure: { subscriptionId: "sub-1", resourceGroup: "rg-1" } };`,
    });
    const cfg = await loadConfig(dir);
    expect(cfg.provider).toBe("azure");
    expect(cfg.azure?.resourceGroup).toBe("rg-1");
  });

  test("azure requires an explicit subscription - it can't be inferred", async () => {
    const dir = makeProject({
      "laranja.config.ts": `export default { name: "api", provider: "azure", azure: { resourceGroup: "rg-1" } };`,
    });
    await expect(loadConfig(dir)).rejects.toThrow(/subscriptionId/);
  });

  test("azure requires a resource group", async () => {
    const dir = makeProject({
      "laranja.config.ts": `export default { name: "api", provider: "azure", azure: { subscriptionId: "sub-1" } };`,
    });
    await expect(loadConfig(dir)).rejects.toThrow(/resourceGroup/);
  });
});
