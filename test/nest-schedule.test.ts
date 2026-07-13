import { describe, test, expect } from "vitest";
import {
  CronExpression,
  CRON_EXPRESSION_VALUES,
  nestCronToSchedule,
  intervalToSchedule,
} from "@alzulejos/laranja-core";

/** Translate and return just the AWS cron expression string, for terse assertions. */
function toAws(expr: string): string {
  const s = nestCronToSchedule(expr, "src/jobs.ts:1");
  if (s.kind !== "cron") throw new Error(`expected cron, got ${s.kind}`);
  return s.expression;
}

describe("nestCronToSchedule() — field translation", () => {
  test("fills the ?-slot for the unconstrained day side (dom vs dow)", () => {
    // Both wild -> dow becomes ?
    expect(toAws("0 12 * * *")).toBe("0 12 * * ? *");
    // dow constrained -> dom becomes ?
    expect(toAws("0 0 * * 1")).toBe("0 0 ? * 2 *");
    // dom constrained -> dow becomes ?
    expect(toAws("0 0 1 * *")).toBe("0 0 1 * ? *");
  });

  test("remaps day-of-week numbering Unix(0=Sun) -> AWS(1=Sun) across ranges and lists", () => {
    expect(toAws("0 0 * * 1-5")).toBe("0 0 ? * 2-6 *"); // Mon-Fri
    expect(toAws("0 0 * * 6,0")).toBe("0 0 ? * 7,1 *"); // Sat,Sun (weekend)
    expect(toAws("0 0 * * 0")).toBe("0 0 ? * 1 *"); // Sunday
    expect(toAws("0 0 * * 7")).toBe("0 0 ? * 1 *"); // 7 also Sunday
  });

  test("drops a leading seconds column of 0 and collapses full-domain range-steps", () => {
    expect(toAws("0 */5 * * * *")).toBe("*/5 * * * ? *"); // EVERY_5_MINUTES
    expect(toAws("0 0-23/1 * * *")).toBe("0 * * * ? *"); // EVERY_HOUR -> hours '*'
    expect(toAws("0 0-23/2 * * *")).toBe("0 */2 * * ? *"); // EVERY_2_HOURS
  });

  test("preserves partial ranges and explicit values", () => {
    expect(toAws("0 */30 9-17 * * *")).toBe("*/30 9-17 * * ? *"); // 9am-5pm window
    expect(toAws("0 0 01 * * 1-5")).toBe("0 1 ? * 2-6 *"); // Mon-Fri at 1am
  });
});

describe("nestCronToSchedule() — rejections (fail loud, never approximate)", () => {
  test("rejects sub-minute / second-offset schedules", () => {
    expect(() => nestCronToSchedule("* * * * * *", "src/x.ts:2")).toThrow(/1-minute minimum/);
    expect(() => nestCronToSchedule("*/30 * * * * *", "src/x.ts:2")).toThrow(/sub-minute/);
    expect(() => nestCronToSchedule("30 * * * * *", "src/x.ts:2")).toThrow(/seconds/);
  });

  test("rejects constraining both day-of-month and day-of-week", () => {
    expect(() => nestCronToSchedule("0 0 1 * 1", "src/x.ts:2")).toThrow(/both day-of-month and day-of-week/);
  });

  test("rejects malformed field counts, with location", () => {
    expect(() => nestCronToSchedule("* * *", "src/x.ts:9")).toThrow(/src\/x\.ts:9/);
    expect(() => nestCronToSchedule("a b c d e f g", "src/x.ts:9")).toThrow(/5- or 6-field/);
  });
});

describe("CronExpression enum → schedule", () => {
  test("common minute/hour/day enums translate", () => {
    expect(toAws(CronExpression.EVERY_DAY_AT_NOON)).toBe("0 12 * * ? *");
    expect(toAws(CronExpression.EVERY_5_MINUTES)).toBe("*/5 * * * ? *");
    expect(toAws(CronExpression.EVERY_WEEKEND)).toBe("0 0 ? * 7,1 *");
    expect(toAws(CronExpression.MONDAY_TO_FRIDAY_AT_9AM)).toBe("0 9 ? * 2-6 *");
  });

  test("second-granularity enums are rejected", () => {
    expect(() => nestCronToSchedule(CronExpression.EVERY_30_SECONDS, "x")).toThrow(/sub-minute/);
  });

  test("CRON_EXPRESSION_VALUES exposes the string values by member name", () => {
    expect(CRON_EXPRESSION_VALUES.EVERY_DAY_AT_NOON).toBe("0 12 * * *");
    expect(CRON_EXPRESSION_VALUES.EVERY_MINUTE).toBe("*/1 * * * *");
  });
});

describe("intervalToSchedule()", () => {
  test("whole-minute intervals become rate schedules", () => {
    expect(intervalToSchedule(60000, "x")).toEqual({ kind: "rate", value: 1, unit: "minute" });
    expect(intervalToSchedule(300000, "x")).toEqual({ kind: "rate", value: 5, unit: "minute" });
  });

  test("sub-minute or non-minute-multiple intervals are rejected", () => {
    expect(() => intervalToSchedule(30000, "x")).toThrow(/1-minute minimum granularity/);
    expect(() => intervalToSchedule(90000, "x")).toThrow(/whole number of minutes/);
    expect(() => intervalToSchedule(0, "x")).toThrow(/positive integer/);
  });
});
