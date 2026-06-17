import { describe, test, expect } from "vitest";
import { rate, every, isAwsScheduleExpression, assertScheduleExpression } from "@laranja/core";

describe("rate()", () => {
  test("pluralizes for values > 1", () => {
    expect(rate(5, "minutes")).toBe("rate(5 minutes)");
    expect(rate(2, "hours")).toBe("rate(2 hours)");
  });

  test("uses the singular unit when the value is 1", () => {
    expect(rate(1, "hour")).toBe("rate(1 hour)");
    expect(rate(1, "minutes")).toBe("rate(1 minute)");
  });

  test("rejects non-positive / non-integer values", () => {
    expect(() => rate(0, "minutes")).toThrow(/positive integer/);
    expect(() => rate(-1, "minutes")).toThrow(/positive integer/);
    expect(() => rate(1.5, "minutes")).toThrow(/positive integer/);
  });
});

describe("every()", () => {
  test("is shorthand for rate(1, unit)", () => {
    expect(every("day")).toBe("rate(1 day)");
    expect(every("minute")).toBe("rate(1 minute)");
  });
});

describe("schedule validation", () => {
  test("accepts valid rate() and cron() expressions", () => {
    expect(isAwsScheduleExpression("rate(5 minutes)")).toBe(true);
    expect(isAwsScheduleExpression("cron(0 12 * * ? *)")).toBe(true);
  });

  test("rejects Unix-cron and malformed expressions", () => {
    expect(isAwsScheduleExpression("*/5 * * * *")).toBe(false);
    expect(isAwsScheduleExpression("rate(5 fortnights)")).toBe(false);
    expect(isAwsScheduleExpression("every 5 minutes")).toBe(false);
  });

  test("assertScheduleExpression throws with location for invalid input", () => {
    expect(() => assertScheduleExpression("*/5 * * * *", "src/jobs.ts:3")).toThrow(/src\/jobs\.ts:3/);
    expect(() => assertScheduleExpression("rate(5 minutes)", "x")).not.toThrow();
  });
});
