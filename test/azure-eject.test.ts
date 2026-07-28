import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { azureWorkloads } from "@alzulejos/laranja-core";
import { ejectedApps, buildDeployScript } from "../packages/cli/src/commands/eject-azure.js";

/** The slice of the IR the grouping reads. */
const ir = (over: Partial<Parameters<typeof azureWorkloads>[0]> = {}) => ({
  crons: [],
  queues: [],
  ...over,
});
const apps = (over: Parameters<typeof ir>[0]) => ejectedApps("shop", "dev", azureWorkloads(ir(over)));

describe("ejectedApps", () => {
  test("an http app with no roots stays ONE app on the historical name + package.zip", () => {
    expect(apps({ http: {}, crons: [{ id: "poll" }] })).toEqual([
      { id: "http", appName: "shop-dev", zip: "package.zip", http: true },
    ]);
  });

  test("each workers() root gets its OWN app and its OWN package", () => {
    // Azure deploys one Function App per workload, each with its own package —
    // an eject shipping a single zip would leave every root with no code.
    expect(
      apps({
        http: {},
        workers: [{ id: "CronsModule" }],
        crons: [{ id: "poll" }, { id: "Tasks-sweep", workersId: "CronsModule" }],
      }),
    ).toEqual([
      { id: "http", appName: "shop-dev", zip: "package.zip", http: true },
      { id: "CronsModule", appName: "shop-dev-cronsmodule", zip: "package-cronsmodule.zip", http: false },
    ]);
  });

  test("a workers-only project ejects — there is no http workload to require", () => {
    // Regression: eject used to demand an "http" handler and threw
    // "Internal: no http handler bundled for eject" for exactly this shape.
    const got = apps({
      workers: [{ id: "CronsModule" }],
      crons: [{ id: "Tasks-sweep", workersId: "CronsModule" }],
    });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: "CronsModule", http: false });
    expect(got.some((a) => a.http)).toBe(false);
  });

  test("package names are unique and filesystem-safe per root", () => {
    const got = apps({
      workers: [{ id: "Billing.Module" }, { id: "Crons_Module" }],
      crons: [{ id: "a", workersId: "Billing.Module" }, { id: "b", workersId: "Crons_Module" }],
    });
    const zips = got.map((a) => a.zip);
    expect(zips).toEqual(["package-billing-module.zip", "package-crons-module.zip"]);
    expect(new Set(zips).size).toBe(zips.length);
    for (const z of zips) expect(z).toMatch(/^[a-z0-9.-]+$/);
  });
});

describe("buildDeployScript", () => {
  const target = { resourceGroup: "my-group" };

  test("publishes EVERY app, not just the first", () => {
    const script = buildDeployScript(
      target,
      apps({ http: {}, workers: [{ id: "CronsModule" }], crons: [{ id: "s", workersId: "CronsModule" }] }),
    );
    expect(script).toContain('"shop-dev:package.zip"');
    expect(script).toContain('"shop-dev-cronsmodule:package-cronsmodule.zip"');
    // One publish loop over the array, so apps can't be silently dropped.
    expect(script).toContain('for entry in "${APPS[@]}"');
    expect(script).toContain("/api/publish?type=zip");
  });

  test("reports the http app's URL, and says so when there isn't one", () => {
    // Only the final "live:" line differs — every app is published either way, so
    // assert that line rather than the SCM publish URLs it shares a host with.
    const liveLine = (s: string) => s.split("\n").find((l) => l.startsWith("echo \"✅"));

    expect(liveLine(buildDeployScript(target, apps({ http: {} })))).toContain(
      "live: https://shop-dev.azurewebsites.net",
    );
    const workersOnly = buildDeployScript(
      target,
      apps({ workers: [{ id: "CronsModule" }], crons: [{ id: "s", workersId: "CronsModule" }] }),
    );
    expect(liveLine(workersOnly)).not.toContain("azurewebsites.net");
    expect(liveLine(workersOnly)).toContain("crons/queues only");
  });

  test("the generated script is valid bash", () => {
    // The script is assembled in a JS template literal, so a mis-escaped `${…}`
    // would ship a broken deploy script to the user with nothing to catch it.
    const script = buildDeployScript(
      target,
      apps({ http: {}, workers: [{ id: "CronsModule" }], crons: [{ id: "s", workersId: "CronsModule" }] }),
    );
    const file = path.join(mkdtempSync(path.join(tmpdir(), "laranja-eject-")), "deploy.sh");
    writeFileSync(file, script);
    expect(() => execFileSync("bash", ["-n", file])).not.toThrow();
  });
});
