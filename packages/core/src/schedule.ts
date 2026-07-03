/**
 * Schedule representation. laranja stores schedules in a PROVIDER-NEUTRAL
 * structured form so the back half can lower them to whatever the target cloud
 * expects (AWS EventBridge `rate(...)`/`cron(...)`, GCP/Cloudflare Unix cron,
 * Azure NCRONTAB, …). The front half never bakes in a provider string.
 *
 * `rate` ("every N units") is portable across every provider. `cron` carries a
 * raw expression tagged with its dialect — an explicit escape hatch (only "aws"
 * exists today; new dialects land with their providers).
 *
 * The builders are pure, which lets the static scanner constant-fold calls like
 * `@Cron(rate(5, "minutes"))` at scan time without executing user code.
 */

/** Units accepted by the `rate()` builder (singular or plural, for ergonomics). */
export type RateUnit = "minute" | "minutes" | "hour" | "hours" | "day" | "days";

/** Canonical singular unit stored in the IR. */
export type ScheduleUnit = "minute" | "hour" | "day";

/** Provider-neutral schedule stored in the IR. */
export type Schedule =
  | { kind: "rate"; value: number; unit: ScheduleUnit }
  | { kind: "cron"; expression: string; dialect: "aws" };

/** Anything accepted where a schedule is expected: structured, or a raw string. */
export type ScheduleInput = Schedule | string;

function toSingular(unit: RateUnit): ScheduleUnit {
  return unit.replace(/s$/, "") as ScheduleUnit;
}

/**
 * Builds a neutral "every N units" schedule.
 *
 * @example rate(5, "minutes") // { kind: "rate", value: 5, unit: "minute" }
 * @example rate(1, "hour")    // { kind: "rate", value: 1, unit: "hour" }
 */
export function rate(value: number, unit: RateUnit): Schedule {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`rate(): value must be a positive integer, got ${value}`);
  }
  return { kind: "rate", value, unit: toSingular(unit) };
}

/**
 * Shorthand for `rate(1, unit)`.
 * @example every("day") // { kind: "rate", value: 1, unit: "day" }
 */
export function every(unit: ScheduleUnit): Schedule {
  return rate(1, unit);
}

const RATE_STRING_RE = /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/;
const CRON_STRING_RE = /^cron\((.+)\)$/;

/**
 * Parse a raw AWS schedule STRING (`"rate(5 minutes)"` / `"cron(0 12 * * ? *)"`)
 * into the neutral structured form. Returns undefined for anything that isn't a
 * valid AWS expression (e.g. a 5-field Unix cron string), so callers can raise a
 * clear error. (Other dialects' string parsing arrives with their providers.)
 */
export function parseScheduleString(s: string): Schedule | undefined {
  const trimmed = s.trim();
  const r = RATE_STRING_RE.exec(trimmed);
  if (r) {
    const value = Number(r[1]);
    if (value < 1) return undefined;
    return { kind: "rate", value, unit: toSingular(r[2] as RateUnit) };
  }
  const c = CRON_STRING_RE.exec(trimmed);
  if (c) return { kind: "cron", expression: c[1], dialect: "aws" };
  return undefined;
}

/** Throws a clear, located error if `s` isn't a valid schedule. */
export function assertSchedule(s: Schedule, where: string): void {
  if (s.kind === "rate") {
    if (!Number.isInteger(s.value) || s.value < 1) {
      throw new Error(`Invalid schedule at ${where}: rate value must be a positive integer, got ${s.value}.`);
    }
    return;
  }
  // Only the "aws" cron dialect exists today; others land with their providers.
  if (s.dialect !== "aws") {
    throw new Error(`Invalid schedule at ${where}: unknown cron dialect "${(s as { dialect: string }).dialect}".`);
  }
  if (!s.expression.trim()) {
    throw new Error(`Invalid schedule at ${where}: empty cron expression.`);
  }
}
