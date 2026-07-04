import { describe, test, expect } from "vitest";
import {
  rate,
  every,
  parseScheduleString,
  assertSchedule,
  describeSchedule,
  nestCronToSchedule,
  CronExpression,
  CRON_EXPRESSION_VALUES,
} from "@alzulejos/laranja-core";

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

describe("describeSchedule()", () => {
  test("renders rates structurally, singular vs plural", () => {
    expect(describeSchedule({ kind: "rate", value: 1, unit: "minute" })).toBe("Every minute");
    expect(describeSchedule({ kind: "rate", value: 5, unit: "minute" })).toBe("Every 5 minutes");
    expect(describeSchedule({ kind: "rate", value: 2, unit: "hour" })).toBe("Every 2 hours");
    expect(describeSchedule({ kind: "rate", value: 1, unit: "day" })).toBe("Every day");
  });

  test("humanizes an AWS-dialect cron, normalizing the ?-slot and day-of-week numbering", () => {
    const at = (expression: string) => describeSchedule({ kind: "cron", expression, dialect: "aws" });
    expect(at("* * * * ? *")).toBe("Every minute");
    expect(at("0 12 * * ? *")).toBe("At 12:00 PM");
    expect(at("30 9 ? * * *")).toBe("At 09:30 AM");
    // AWS day-of-week: 1=Sun..7=Sat. `2-6` == Mon-Fri, `7,1` == Sat,Sun.
    expect(at("0 0 ? * 2-6 *")).toBe("At 12:00 AM, Monday through Friday");
    expect(at("0 0 ? * 7,1 *")).toBe("At 12:00 AM, only on Sunday and Saturday");
  });

  test("falls back to the raw expression for anything cronstrue can't parse", () => {
    // Never surface a misleading label; show the raw cron instead.
    expect(describeSchedule({ kind: "cron", expression: "garbage ? nonsense", dialect: "aws" })).toBe(
      "garbage ? nonsense",
    );
  });

  // The end-to-end path a Nest user hits: `@Cron(CronExpression.X)` -> scanner folds
  // the enum to its node-cron string -> nestCronToSchedule lowers to AWS -> describeSchedule.
  describe("via the @nestjs/schedule CronExpression pipeline", () => {
    const humanize = (member: keyof typeof CronExpression) =>
      describeSchedule(nestCronToSchedule(CronExpression[member], "src/jobs.ts:1"));

    test.each([
      ["EVERY_MINUTE", "Every minute"],
      ["EVERY_5_MINUTES", "Every 5 minutes"],
      ["EVERY_30_MINUTES", "Every 30 minutes"],
      ["EVERY_HOUR", "Every hour"],
      ["EVERY_DAY_AT_NOON", "At 12:00 PM"],
      ["EVERY_DAY_AT_MIDNIGHT", "At 12:00 AM"],
      ["EVERY_WEEKDAY", "At 12:00 AM, Monday through Friday"],
      ["EVERY_WEEKEND", "At 12:00 AM, only on Sunday and Saturday"],
      ["EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT", "At 12:00 AM, on day 1 of the month"],
      ["MONDAY_TO_FRIDAY_AT_09_30AM", "At 09:30 AM, Monday through Friday"],
    ] as const)("%s -> %s", (member, expected) => {
      expect(humanize(member)).toBe(expected);
    });

    test("every enum member EventBridge can honor gets a clean label (no raw-cron fallback)", () => {
      // Sub-minute members (EVERY_SECOND, EVERY_*_SECONDS) are rejected at lowering
      // — EventBridge's 1-minute floor — so they never reach describeSchedule.
      const fellBack: string[] = [];
      let described = 0;
      for (const [name, expr] of Object.entries(CRON_EXPRESSION_VALUES)) {
        let schedule;
        try {
          schedule = nestCronToSchedule(expr, "x");
        } catch {
          continue; // sub-minute: not expressible on EventBridge, tested in nest-schedule.test.ts
        }
        described++;
        const label = describeSchedule(schedule);
        expect(label).not.toBe("");
        if (schedule.kind === "cron" && label === schedule.expression) fellBack.push(name);
      }
      expect(fellBack).toEqual([]);
      expect(described).toBeGreaterThan(70); // guards against the loop silently going empty
    });
  });
});
