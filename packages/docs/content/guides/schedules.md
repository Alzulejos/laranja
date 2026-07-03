---
title: Schedules
description: The rate() and every() builders, and raw schedule expressions.
order: 4
---

# Schedules

Schedules drive [cron jobs](./cron-jobs.md). laranja stores them in a
**provider-neutral** form, so prefer the builders — they're portable across
clouds. A raw expression string is available as an escape hatch.

## `rate(value, unit)`

"Every N units." Portable everywhere.

```ts
import { rate } from "@laranja/decorators";

rate(5, "minutes")   // every 5 minutes
rate(1, "hour")      // every hour
rate(2, "days")      // every 2 days
```

- `value` must be a **positive integer** (≥ 1).
- `unit` is one of `"minute"`, `"minutes"`, `"hour"`, `"hours"`, `"day"`,
  `"days"` — singular or plural, your choice.

## `every(unit)`

Shorthand for `rate(1, unit)`. Takes a singular unit:

```ts
import { every } from "@laranja/decorators";

every("minute")   // = rate(1, "minute")
every("hour")     // = rate(1, "hour")
every("day")      // = rate(1, "day")
```

## Raw AWS expressions (escape hatch)

When you need something the builders can't express (e.g. "noon UTC every day"),
pass a **wrapped** AWS schedule string — `cron(...)` or `rate(...)`:

```ts
@Cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" })  // 12:00 UTC daily
@Cron("rate(5 minutes)")                                       // raw rate string
```

AWS cron has **six fields**: `cron(Minutes Hours Day-of-month Month Day-of-week
Year)`.

A few examples:

| Expression | Meaning |
|---|---|
| `cron(0 12 * * ? *)` | 12:00 UTC every day |
| `cron(0/15 * * * ? *)` | every 15 minutes |
| `cron(0 8 ? * MON-FRI *)` | 08:00 UTC on weekdays |
| `cron(0 0 1 * ? *)` | midnight UTC on the 1st of each month |

## node-cron expressions (`@nestjs/schedule` compatibility)

A **bare** (unwrapped) string is read as a standard 5- or 6-field
[node-cron](https://github.com/kelektiv/node-cron) expression — the same syntax
`@nestjs/schedule`'s `@Cron` takes. laranja translates it to the AWS dialect for
you, so a Nest app can swap the import and keep its existing schedules:

```ts
@Cron("0 12 * * *")                 // noon every day
@Cron("*/5 * * * *")                // every 5 minutes
@Cron("0 0 * * 1-5")                // midnight on weekdays
@Cron(CronExpression.EVERY_30_MINUTES)  // the enum works too
```

`CronExpression` (mirrored from `@nestjs/schedule`) is re-exported from
`@laranja/decorators`. Translation handles the day-of-week numbering difference
(Unix `0`=Sun → AWS `1`=Sun) and the day-of-month/day-of-week rule for you.

**What can't be translated is rejected at build time — never silently rounded:**

| Input | Why it's rejected |
|---|---|
| `"*/30 * * * * *"`, `CronExpression.EVERY_30_SECONDS` | Sub-minute — EventBridge's floor is **1 minute**. |
| A seconds field other than `0` | Second-level offsets can't be expressed. |
| A cron constraining **both** day-of-month and day-of-week | EventBridge requires one to be `*`. |

## `@Interval(ms)`

`@nestjs/schedule`'s `@Interval` is supported and lowers to a `rate(...)`. The
interval must be a whole number of minutes (EventBridge's floor):

```ts
@Interval(300000)          // every 5 minutes  → rate(5, "minutes")
@Interval("poll", 300000)  // named
```

> `@Timeout` (a one-shot timer relative to process start) has no serverless
> equivalent and is rejected with a clear message — use `@Cron` or `@Interval`.

## Where you can use them

Anywhere a schedule is expected — the decorator or the function marker — accepts
a builder result, a `Schedule` object, or a raw string:

```ts
@Cron(rate(5, "minutes"))                       // builder
@Cron("rate(5 minutes)")                        // raw string
@Cron({ schedule: every("day"), id: "nightly" })// builder + explicit id
cron(rate(1, "hour"), refreshCache);            // function marker
```

## Related

- [Cron jobs](./cron-jobs.md)
- [`@Cron` / `cron()` reference](../reference/decorators-and-markers.md#cron)
