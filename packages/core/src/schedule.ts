/**
 * AWS-native schedule helpers. laranja does NOT translate Unix cron — schedules
 * are AWS EventBridge expressions (`rate(...)` / `cron(...)`). These builders just
 * give users a typed, footgun-free way to produce valid `rate(...)` strings.
 *
 * They are pure functions, which lets the static scanner constant-fold calls like
 * `@Cron(rate(5, "minutes"))` at scan time without executing user code.
 */

export type RateUnit = "minute" | "minutes" | "hour" | "hours" | "day" | "days";

/**
 * Builds an AWS `rate(...)` expression. AWS requires the singular unit when the
 * value is 1 (`rate(1 minute)`) and plural otherwise (`rate(5 minutes)`).
 *
 * @example rate(5, "minutes") // "rate(5 minutes)"
 * @example rate(1, "hour")    // "rate(1 hour)"
 */
export function rate(value: number, unit: RateUnit): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`rate(): value must be a positive integer, got ${value}`);
  }
  const singular = unit.replace(/s$/, "");
  return `rate(${value} ${value === 1 ? singular : `${singular}s`})`;
}

/**
 * Shorthand for `rate(1, unit)`.
 * @example every("day") // "rate(1 day)"
 */
export function every(unit: "minute" | "hour" | "day"): string {
  return rate(1, unit);
}

const RATE_RE = /^rate\(\d+\s+(minute|minutes|hour|hours|day|days)\)$/;
const CRON_RE = /^cron\(.+\)$/;

/** True if `s` is a syntactically valid AWS `rate(...)`/`cron(...)` expression. */
export function isAwsScheduleExpression(s: string): boolean {
  return RATE_RE.test(s) || CRON_RE.test(s);
}

/** Throws a clear error if `s` isn't a valid AWS schedule expression. */
export function assertScheduleExpression(s: string, where: string): void {
  if (!isAwsScheduleExpression(s)) {
    throw new Error(
      `Invalid schedule "${s}" at ${where}. ` +
        `Schedules are AWS expressions — use rate(n, unit), every(unit), ` +
        `or a raw "cron(...)"/"rate(...)" string (e.g. "cron(0 12 * * ? *)").`,
    );
  }
}
