import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginRun,
  step,
  note,
  buildFailureReport,
  writeFailureReport,
  sendFailureReport,
} from "../packages/cli/src/diagnostics.js";

describe("diagnostics", () => {
  let home: string;
  const prevHome = process.env.LARANJA_HOME;
  const prevKey = process.env.LARANJA_API_KEY;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "laranja-diag-"));
    process.env.LARANJA_HOME = home; // isolate auth dir + the errors.jsonl write
    delete process.env.LARANJA_API_KEY;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.LARANJA_HOME;
    else process.env.LARANJA_HOME = prevHome;
    if (prevKey === undefined) delete process.env.LARANJA_API_KEY;
    else process.env.LARANJA_API_KEY = prevKey;
  });

  test("captures command, step, reason, and noted context", () => {
    beginRun("deploy", "/tmp/proj");
    note({ project: "demo", region: "eu-central-1" });
    step("server synth");
    const report = buildFailureReport(new Error("boom"));
    expect(report).toMatchObject({
      command: "deploy",
      step: "server synth",
      reason: "boom",
      errorName: "Error",
      fields: { project: "demo", region: "eu-central-1" },
    });
    expect(report.stack).toContain("boom");
    expect(typeof report.durationMs).toBe("number");
  });

  test("appends a JSON line to errors.jsonl under LARANJA_HOME", () => {
    beginRun("destroy");
    step("delete stack");
    const file = writeFailureReport(buildFailureReport(new Error("nope")));
    expect(file).toBe(path.join(home, "errors.jsonl"));
    const parsed = JSON.parse(readFileSync(file!, "utf8").trim());
    expect(parsed).toMatchObject({ command: "destroy", step: "delete stack", reason: "nope" });
  });

  test("sendFailureReport is a silent no-op when not logged in", async () => {
    beginRun("deploy", "/tmp/proj");
    expect(await sendFailureReport(buildFailureReport(new Error("x")))).toBe(false);
  });
});
