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

## Raw expressions (escape hatch)

When you need something the builders can't express (e.g. "noon UTC every day"),
pass a raw AWS schedule string. Today the only supported dialect is **AWS**.

```ts
@Cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" })  // 12:00 UTC daily
@Cron("rate(5 minutes)")                                       // raw rate string
```

AWS cron has **six fields**: `cron(Minutes Hours Day-of-month Month Day-of-week
Year)`. Note this differs from the 5-field Unix cron — a 5-field string is
rejected with a clear error.

A few examples:

| Expression | Meaning |
|---|---|
| `cron(0 12 * * ? *)` | 12:00 UTC every day |
| `cron(0/15 * * * ? *)` | every 15 minutes |
| `cron(0 8 ? * MON-FRI *)` | 08:00 UTC on weekdays |
| `cron(0 0 1 * ? *)` | midnight UTC on the 1st of each month |

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
