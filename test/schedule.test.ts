import { describe, test, expect } from "vitest";
import { rate, every, parseScheduleString, assertSchedule } from "@alzulejos/laranja-core";

describe("rate()", () => {
  test("builds a structured, provider-neutral schedule (pluralization deferred to render time)", () => {
    expect(rate(5, "minutes")).toEqual({ kind: "rate", value: 5, unit: "minute" });
    expect(rate(2, "hours")).toEqual({ kind: "rate", value: 2, unit: "hour" });
  });

  test("normalizes to the singular unit", () => {
    expect(rate(1, "hour")).toEqual({ kind: "rate", value: 1, unit: "hour" });
    expect(rate(1, "minutes")).toEqual({ kind: "rate", value: 1, unit: "minute" });
  });

  test("rejects non-positive / non-integer values", () => {
    expect(() => rate(0, "minutes")).toThrow(/positive integer/);
    expect(() => rate(-1, "minutes")).toThrow(/positive integer/);
    expect(() => rate(1.5, "minutes")).toThrow(/positive integer/);
  });
});

describe("every()", () => {
  test("is shorthand for rate(1, unit)", () => {
    expect(every("day")).toEqual({ kind: "rate", value: 1, unit: "day" });
    expect(every("minute")).toEqual({ kind: "rate", value: 1, unit: "minute" });
  });
});

describe("parseScheduleString()", () => {
  test("parses raw AWS rate()/cron() strings into the neutral form", () => {
    expect(parseScheduleString("rate(5 minutes)")).toEqual({ kind: "rate", value: 5, unit: "minute" });
    expect(parseScheduleString("rate(1 hour)")).toEqual({ kind: "rate", value: 1, unit: "hour" });
    expect(parseScheduleString("cron(0 12 * * ? *)")).toEqual({
      kind: "cron",
      expression: "0 12 * * ? *",
      dialect: "aws",
    });
  });

  test("returns undefined for Unix-cron and malformed expressions", () => {
    expect(parseScheduleString("*/5 * * * *")).toBeUndefined();
    expect(parseScheduleString("rate(5 fortnights)")).toBeUndefined();
    expect(parseScheduleString("every 5 minutes")).toBeUndefined();
    expect(parseScheduleString("rate(0 minutes)")).toBeUndefined();
  });
});

describe("assertSchedule()", () => {
  test("accepts valid structured schedules", () => {
    expect(() => assertSchedule({ kind: "rate", value: 5, unit: "minute" }, "x")).not.toThrow();
    expect(() => assertSchedule({ kind: "cron", expression: "0 12 * * ? *", dialect: "aws" }, "x")).not.toThrow();
  });

  test("throws with location for invalid input", () => {
    expect(() => assertSchedule({ kind: "rate", value: 0, unit: "minute" }, "src/jobs.ts:3")).toThrow(/src\/jobs\.ts:3/);
    expect(() => assertSchedule({ kind: "cron", expression: "   ", dialect: "aws" }, "src/jobs.ts:3")).toThrow(
      /src\/jobs\.ts:3/,
    );
  });
});
