/**
 * `@nestjs/schedule` compatibility. A Nest user should be able to swap the
 * `@Cron` import from `@nestjs/schedule` to laranja and keep their existing
 * schedules — so we accept node-cron expressions (and the `CronExpression` enum)
 * and translate them into laranja's neutral `Schedule` here, in the front half.
 *
 * We lower to an AWS EventBridge `cron(...)` expression (the only dialect the back
 * half understands today). node-cron and EventBridge cron differ in real ways —
 * sub-minute granularity, day-of-week numbering, and the mutually-exclusive
 * day-of-month/day-of-week rule (EventBridge requires exactly one of them to be
 * `?`). So this both TRANSLATES what maps and REJECTS, loudly and with a source
 * location, what EventBridge physically cannot honor. We never silently round a
 * schedule to a different cadence — a job the user thinks runs every 30s must not
 * quietly become every minute.
 */

import { rate, type Schedule } from "./schedule.js";

/**
 * Mirror of `@nestjs/schedule`'s `CronExpression` enum (values copied verbatim),
 * re-exported so users who `import { CronExpression }` can point it at laranja and
 * keep compiling. The scanner resolves `CronExpression.MEMBER` to its string value
 * through this same object, so the two stay in lockstep by construction.
 */
export enum CronExpression {
  EVERY_SECOND = "* * * * * *",
  EVERY_5_SECONDS = "*/5 * * * * *",
  EVERY_10_SECONDS = "*/10 * * * * *",
  EVERY_30_SECONDS = "*/30 * * * * *",
  EVERY_MINUTE = "*/1 * * * *",
  EVERY_5_MINUTES = "0 */5 * * * *",
  EVERY_10_MINUTES = "0 */10 * * * *",
  EVERY_30_MINUTES = "0 */30 * * * *",
  EVERY_HOUR = "0 0-23/1 * * *",
  EVERY_2_HOURS = "0 0-23/2 * * *",
  EVERY_3_HOURS = "0 0-23/3 * * *",
  EVERY_4_HOURS = "0 0-23/4 * * *",
  EVERY_5_HOURS = "0 0-23/5 * * *",
  EVERY_6_HOURS = "0 0-23/6 * * *",
  EVERY_7_HOURS = "0 0-23/7 * * *",
  EVERY_8_HOURS = "0 0-23/8 * * *",
  EVERY_9_HOURS = "0 0-23/9 * * *",
  EVERY_10_HOURS = "0 0-23/10 * * *",
  EVERY_11_HOURS = "0 0-23/11 * * *",
  EVERY_12_HOURS = "0 0-23/12 * * *",
  EVERY_DAY_AT_1AM = "0 01 * * *",
  EVERY_DAY_AT_2AM = "0 02 * * *",
  EVERY_DAY_AT_3AM = "0 03 * * *",
  EVERY_DAY_AT_4AM = "0 04 * * *",
  EVERY_DAY_AT_5AM = "0 05 * * *",
  EVERY_DAY_AT_6AM = "0 06 * * *",
  EVERY_DAY_AT_7AM = "0 07 * * *",
  EVERY_DAY_AT_8AM = "0 08 * * *",
  EVERY_DAY_AT_9AM = "0 09 * * *",
  EVERY_DAY_AT_10AM = "0 10 * * *",
  EVERY_DAY_AT_11AM = "0 11 * * *",
  EVERY_DAY_AT_NOON = "0 12 * * *",
  EVERY_DAY_AT_1PM = "0 13 * * *",
  EVERY_DAY_AT_2PM = "0 14 * * *",
  EVERY_DAY_AT_3PM = "0 15 * * *",
  EVERY_DAY_AT_4PM = "0 16 * * *",
  EVERY_DAY_AT_5PM = "0 17 * * *",
  EVERY_DAY_AT_6PM = "0 18 * * *",
  EVERY_DAY_AT_7PM = "0 19 * * *",
  EVERY_DAY_AT_8PM = "0 20 * * *",
  EVERY_DAY_AT_9PM = "0 21 * * *",
  EVERY_DAY_AT_10PM = "0 22 * * *",
  EVERY_DAY_AT_11PM = "0 23 * * *",
  EVERY_DAY_AT_MIDNIGHT = "0 0 * * *",
  EVERY_WEEK = "0 0 * * 0",
  EVERY_WEEKDAY = "0 0 * * 1-5",
  EVERY_WEEKEND = "0 0 * * 6,0",
  EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT = "0 0 1 * *",
  EVERY_1ST_DAY_OF_MONTH_AT_NOON = "0 12 1 * *",
  EVERY_2ND_HOUR = "0 */2 * * *",
  EVERY_2ND_HOUR_FROM_1AM_THROUGH_11PM = "0 1-23/2 * * *",
  EVERY_2ND_MONTH = "0 0 1 */2 *",
  EVERY_QUARTER = "0 0 1 */3 *",
  EVERY_6_MONTHS = "0 0 1 */6 *",
  EVERY_YEAR = "0 0 1 1 *",
  EVERY_30_MINUTES_BETWEEN_9AM_AND_5PM = "0 */30 9-17 * * *",
  EVERY_30_MINUTES_BETWEEN_9AM_AND_6PM = "0 */30 9-18 * * *",
  EVERY_30_MINUTES_BETWEEN_10AM_AND_7PM = "0 */30 10-19 * * *",
  MONDAY_TO_FRIDAY_AT_1AM = "0 0 01 * * 1-5",
  MONDAY_TO_FRIDAY_AT_2AM = "0 0 02 * * 1-5",
  MONDAY_TO_FRIDAY_AT_3AM = "0 0 03 * * 1-5",
  MONDAY_TO_FRIDAY_AT_4AM = "0 0 04 * * 1-5",
  MONDAY_TO_FRIDAY_AT_5AM = "0 0 05 * * 1-5",
  MONDAY_TO_FRIDAY_AT_6AM = "0 0 06 * * 1-5",
  MONDAY_TO_FRIDAY_AT_7AM = "0 0 07 * * 1-5",
  MONDAY_TO_FRIDAY_AT_8AM = "0 0 08 * * 1-5",
  MONDAY_TO_FRIDAY_AT_9AM = "0 0 09 * * 1-5",
  MONDAY_TO_FRIDAY_AT_09_30AM = "0 30 09 * * 1-5",
  MONDAY_TO_FRIDAY_AT_10AM = "0 0 10 * * 1-5",
  MONDAY_TO_FRIDAY_AT_11AM = "0 0 11 * * 1-5",
  MONDAY_TO_FRIDAY_AT_11_30AM = "0 30 11 * * 1-5",
  MONDAY_TO_FRIDAY_AT_12PM = "0 0 12 * * 1-5",
  MONDAY_TO_FRIDAY_AT_1PM = "0 0 13 * * 1-5",
  MONDAY_TO_FRIDAY_AT_2PM = "0 0 14 * * 1-5",
  MONDAY_TO_FRIDAY_AT_3PM = "0 0 15 * * 1-5",
  MONDAY_TO_FRIDAY_AT_4PM = "0 0 16 * * 1-5",
  MONDAY_TO_FRIDAY_AT_5PM = "0 0 17 * * 1-5",
  MONDAY_TO_FRIDAY_AT_6PM = "0 0 18 * * 1-5",
  MONDAY_TO_FRIDAY_AT_7PM = "0 0 19 * * 1-5",
  MONDAY_TO_FRIDAY_AT_8PM = "0 0 20 * * 1-5",
  MONDAY_TO_FRIDAY_AT_9PM = "0 0 21 * * 1-5",
  MONDAY_TO_FRIDAY_AT_10PM = "0 0 22 * * 1-5",
  MONDAY_TO_FRIDAY_AT_11PM = "0 0 23 * * 1-5",
}

/** Every enum string keyed by member name — used by the scanner to fold `CronExpression.X`. */
export const CRON_EXPRESSION_VALUES: Record<string, string> = Object.fromEntries(
  Object.entries(CronExpression).filter(([, v]) => typeof v === "string"),
) as Record<string, string>;

/**
 * Strip leading zeros from every numeric token in a field (`09` -> `9`, `01-05`
 * -> `1-5`). The Nest enum zero-pads hours and days, which EventBridge's parser
 * rejects. Non-numeric tokens (`*`, `?`, `,`, `-`, `/`, names) are left intact.
 */
function stripZeros(field: string): string {
  return field.replace(/\d+/g, (d) => String(parseInt(d, 10)));
}

/**
 * Collapse a full-domain range-step (`0-23/2`) or full range (`0-59`) to the `*`
 * form EventBridge prefers, and drop a redundant `/1` step. Leaves anything else
 * (explicit values, lists, partial ranges) untouched. Assumes zeros already stripped.
 */
function normalizeField(field: string, min: number, max: number): string {
  const full = new RegExp(`^${min}-${max}(?:/(\\d+))?$`);
  const m = full.exec(field);
  if (m) return m[1] && m[1] !== "1" ? `*/${m[1]}` : "*";
  const starStep = /^\*\/1$/.exec(field);
  if (starStep) return "*";
  return field;
}

/** Translate one numeric day-of-week token from Unix (0-7, 0/7=Sun) to AWS (1-7, 1=Sun). */
function translateDowNumber(token: string): string {
  if (!/^\d+$/.test(token)) return token; // names (MON..SUN) pass through — AWS accepts them
  const n = Number(token);
  if (n < 0 || n > 7) return token; // out of range: let AWS reject it with its own message
  return String((n % 7) + 1);
}

/** Apply the Unix→AWS day-of-week remap across ranges (`1-5`) and lists (`6,0`). */
function translateDow(field: string): string {
  if (field === "*" || field === "?") return field;
  return field
    .split(",")
    .map((part) =>
      part
        .split("/")
        .map((seg, i) =>
          // Only the value/range segment is remapped; a trailing `/step` is numeric, left as-is.
          i === 0 ? seg.split("-").map(translateDowNumber).join("-") : seg,
        )
        .join("/"),
    )
    .join(",");
}

const SPECIFIED = (v: string): boolean => v !== "*" && v !== "?";

/**
 * Translate a node-cron expression (5-field `min hour dom month dow`, or 6-field
 * with a leading seconds column) into a neutral AWS-dialect cron `Schedule`.
 * Throws a clear, located error for anything EventBridge can't express.
 *
 * NOTE on the seconds column: EventBridge has a 1-minute floor, so the only
 * seconds value we accept is `0` ("at the top of the minute"), which we drop.
 * Any other seconds value is a sub-minute or second-offset schedule and is
 * rejected rather than approximated.
 */
export function nestCronToSchedule(expr: string, where: string): Schedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error(
      `schedule at ${where}: "${expr}" is not a 5- or 6-field cron expression.`,
    );
  }

  let fields = parts;
  if (parts.length === 6) {
    const seconds = parts[0];
    if (seconds !== "0") {
      throw new Error(
        `schedule at ${where}: "${expr}" uses a sub-minute seconds field ("${seconds}"). ` +
          `EventBridge has a 1-minute minimum granularity, so only a seconds value of "0" is supported.`,
      );
    }
    fields = parts.slice(1);
  }

  let dayOfMonth = stripZeros(fields[2]);
  const month = stripZeros(fields[3]);
  let dayOfWeek = translateDow(fields[4]);
  const minute = normalizeField(stripZeros(fields[0]), 0, 59);
  const hour = normalizeField(stripZeros(fields[1]), 0, 23);

  // EventBridge forbids specifying BOTH day-of-month and day-of-week; exactly one
  // must be `?`. Unix cron allows `* * `, so we pick the `?` for whichever side the
  // user didn't constrain — and reject the genuinely-ambiguous "both constrained".
  const domSpec = SPECIFIED(dayOfMonth);
  const dowSpec = SPECIFIED(dayOfWeek);
  if (domSpec && dowSpec) {
    throw new Error(
      `schedule at ${where}: "${expr}" constrains both day-of-month and day-of-week. ` +
        `EventBridge cron can't AND them — set one of the two to "*".`,
    );
  }
  if (dowSpec) dayOfMonth = "?";
  else dayOfWeek = "?";

  return {
    kind: "cron",
    expression: `${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek} *`,
    dialect: "aws",
  };
}

/**
 * Translate `@Interval(ms)` into a neutral rate `Schedule`. Unlike `@Cron`,
 * `@Interval` genuinely means "every N milliseconds", which maps to EventBridge's
 * clock-independent `rate(...)`. EventBridge's floor is one minute, so the
 * interval must be a whole number of minutes.
 */
export function intervalToSchedule(ms: number, where: string): Schedule {
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`@Interval at ${where}: interval must be a positive integer of milliseconds, got ${ms}.`);
  }
  if (ms % 60000 !== 0) {
    throw new Error(
      `@Interval at ${where}: ${ms}ms is not a whole number of minutes. ` +
        `EventBridge has a 1-minute minimum granularity, so intervals must be multiples of 60000ms.`,
    );
  }
  return rate(ms / 60000, "minutes");
}
