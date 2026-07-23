import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateEntries, type GeneratedEntry } from "@alzulejos/laranja-runtime";
import { bundleEntries } from "@alzulejos/laranja-assembly";
import { buildAzureHostJson, AZURE_HTTP_FUNCTION_NAME, armParamName, azureCronScheduleSettingKey } from "@alzulejos/laranja-core";
import type { InfraIR } from "@alzulejos/laranja-core";

function azureIR(): InfraIR {
  return {
    app: { name: "shop", framework: "express", provider: "azure", stage: "dev", monitoring: false, entry: "src/app.ts" },
    http: { handlerEntry: "src/app.ts", appExport: "app", routes: [{ method: "GET", path: "/", source: "src/app.ts:3" }] },
    crons: [],
    queues: [],
    env: {},
    envKeys: [],
  };
}

describe("azure codegen", () => {
  test("the shim registers instead of exporting a handler", () => {
    const entries = generateEntries(azureIR(), {
      projectDir: "/proj",
      entryDir: "/proj/.laranja/entries",
    });
    const http = entries.find((e: GeneratedEntry) => e.id === "http")!;
    expect(http.contents).toContain("registerAzureHttp(app)");
    expect(http.contents).not.toContain("export const handler");
    // Empty handlerExport is the signal that there's no symbol to look up — the
    // Functions host discovers functions from the loaded package instead.
    expect(http.handlerExport).toBe("");
  });

  test("NestJS on azure is refused rather than silently mis-bundled", () => {
    const ir = azureIR();
    ir.app.framework = "nest";
    ir.http!.appExport = "bootstrap";
    expect(() =>
      generateEntries(ir, { projectDir: "/proj", entryDir: "/proj/.laranja/entries" }),
    ).toThrow(/Express-only/);
  });
});

describe("azure host.json", () => {
  test("the timeout is rendered as HH:MM:SS, not seconds", () => {
    expect(buildAzureHostJson(90).functionTimeout).toBe("00:01:30");
    expect(buildAzureHostJson(30).functionTimeout).toBe("00:00:30");
    expect(buildAzureHostJson(3661).functionTimeout).toBe("01:01:01");
  });

  test("declares the extension bundle Flex Consumption requires", () => {
    const host = buildAzureHostJson(30) as { extensionBundle: { version: string } };
    expect(host.extensionBundle.version).toBe("[4.0.0, 5.0.0)");
  });
});

describe("azure package layout", () => {
  test("host.json and package.json land at the asset ROOT", async () => {
    // ⚠️ This is the silent-failure trap: if these aren't at the zip root, the
    // Functions host detects NO functions and reports no error at all.
    const dir = mkdtempSync(path.join(tmpdir(), "laranja-azure-pkg-"));
    try {
      const projectDir = path.join(dir, "proj");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        path.join(projectDir, "app.js"),
        "const app = (req, res) => res.end('ok');\nmodule.exports = { app };\n",
      );

      const entries: GeneratedEntry[] = [
        {
          id: "http",
          kind: "http",
          fileName: "http.ts",
          handlerExport: "",
          // Kept dependency-free so the bundle doesn't need the runtime installed.
          contents: `const { app } = require("${path.join(projectDir, "app.js")}");\nglobalThis.__app = app;\n`,
        },
      ];

      const handlers = await bundleEntries(entries, {
        entryDir: path.join(dir, "entries"),
        buildDir: path.join(dir, "build"),
        projectDir,
        provider: "azure",
        httpTimeoutSeconds: 45,
      });

      const assetDir = handlers[0].assetDir;
      expect(existsSync(path.join(assetDir, "host.json"))).toBe(true);
      expect(existsSync(path.join(assetDir, "package.json"))).toBe(true);
      // Azure resolves the entry through `main`, so it must be .js (not .cjs).
      expect(existsSync(path.join(assetDir, "index.js"))).toBe(true);

      const pkg = JSON.parse(readFileSync(path.join(assetDir, "package.json"), "utf8"));
      expect(pkg.main).toBe("index.js");
      expect(pkg.dependencies).toHaveProperty("@azure/functions");
      // `type: module` would make the CJS bundle fail to load.
      expect(pkg.type).toBeUndefined();

      const host = JSON.parse(readFileSync(path.join(assetDir, "host.json"), "utf8"));
      expect(host.functionTimeout).toBe("00:00:45");

      // No handler string: there's no symbol for the host to look up.
      expect(handlers[0].handler).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("azure contracts", () => {
  test("the registered function name is a single shared constant", () => {
    expect(AZURE_HTTP_FUNCTION_NAME).toBe("api");
  });

  test("cron schedule setting key is a stable, sanitized contract", () => {
    // laranja-cdk writes this app setting; the shim binds `schedule: '%KEY%'`.
    // Both derive it from the cron id, so the exact format is load-bearing.
    expect(azureCronScheduleSettingKey("poll")).toBe("LARANJA_CRON_poll_SCHEDULE");
    // Non-alphanumerics fold to underscore; case is preserved (Linux is case-sensitive).
    expect(azureCronScheduleSettingKey("Jobs.refreshCache")).toBe("LARANJA_CRON_Jobs_refreshCache_SCHEDULE");
  });

  test("armParamName is injective where the AWS param name is lossy", () => {
    // envParamName strips non-alphanumerics, so MY_SECRET and MYSECRET collide.
    // ARM parameter names allow underscores, so these must stay distinct.
    expect(armParamName("MY_SECRET")).not.toBe(armParamName("MYSECRET"));
  });
});
