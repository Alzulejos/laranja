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

import cronstrue from "cronstrue";

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

/**
 * Remap one AWS day-of-week field back to standard Unix numbering. AWS uses 1-7
 * with 1=Sunday; cronstrue (like Unix cron) uses 0-6 with 0=Sunday — so numeric
 * tokens shift down by one. Only the value/range segment is remapped; a trailing
 * `/step` is a count, not a day, and passes through. Names (MON..SUN) pass through.
 * Mirrors the inverse of `translateDow` in nest-schedule.ts.
 */
function awsDowToStandard(field: string): string {
  if (field === "*" || field === "?") return "*";
  return field
    .split(",")
    .map((part) =>
      part
        .split("/")
        .map((seg, i) =>
          i === 0
            ? seg
                .split("-")
                .map((t) => {
                  const n = Number(t);
                  return /^\d+$/.test(t) && n >= 1 && n <= 7 ? String(n - 1) : t;
                })
                .join("-")
            : seg,
        )
        .join("/"),
    )
    .join(",");
}

/**
 * Convert laranja's stored AWS EventBridge cron (`min hour dom month dow [year]`,
 * with `?` placeholders and AWS day-of-week numbering) into a standard 5-field
 * Unix expression (`*` placeholders, 0=Sunday) that cronstrue understands. The
 * inverse of the lowering `nestCronToSchedule` performs. Returns the input
 * untouched for anything that isn't 5- or 6-field, so the caller can fall back.
 *
 * Exported because it is the single source of truth for the AWS-dialect quirks
 * (`?` placeholders, 1=Sunday day-of-week, trailing year field): `describeSchedule`
 * uses it for cronstrue, and the Azure back half builds NCRONTAB on top of it
 * rather than re-deriving the same conversion.
 */
export function awsCronToStandard(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return expr;
  const [minute, hour, dom, month, dow] = parts; // parts[5] (year) is dropped
  return [minute, hour, dom === "?" ? "*" : dom, month, awsDowToStandard(dow)].join(" ");
}

/**
 * Human-readable description of a Schedule — the single source of truth for how a
 * schedule is shown to a user (the CLI `plan` table and the dashboard both call
 * this, so the wording never drifts). `rate` renders structurally; `cron` is
 * normalized from our AWS dialect to standard Unix cron and handed to cronstrue.
 * Anything cronstrue can't parse falls back to the raw expression, so we never
 * show a misleading label.
 *
 * @example describeSchedule({ kind: "rate", value: 5, unit: "minute" }) // "Every 5 minutes"
 * @example describeSchedule({ kind: "cron", expression: "* * * * ? *", dialect: "aws" }) // "Every minute"
 */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "rate") {
    return schedule.value === 1
      ? `Every ${schedule.unit}`
      : `Every ${schedule.value} ${schedule.unit}s`;
  }
  const standard = awsCronToStandard(schedule.expression);
  try {
    return cronstrue.toString(standard, { throwExceptionOnParseError: true, verbose: false });
  } catch {
    return schedule.expression;
  }
}
