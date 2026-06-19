---
title: Cron jobs
description: Run functions on a schedule with @Cron or cron().
order: 2
---

# Cron jobs

A cron job is a function that runs on a schedule. Each one becomes
[its own Lambda plus an EventBridge rule](../concepts/what-gets-deployed.md#cron--lambda--eventbridge-rule).

## Class style — `@Cron`

Decorate a method with [`@Cron`](../reference/decorators-and-markers.md#cron) and
give it a [schedule](./schedules.md):

```ts
import { Cron, rate, every } from "@laranja/decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() {
    // …
  }

  @Cron(every("day"))
  async nightlyCleanup() {
    // …
  }

  @Cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" })
  async sendReport() {
    // …
  }
}
```

The handler's logical id defaults to `‹Class›-‹method›`; pass `id` to set a
stable, explicit name (which also drives the Lambda's name).

## Function style — `cron()`

If you don't use classes, register a standalone exported function with
[`cron()`](../reference/decorators-and-markers.md#cron-marker):

```ts
import { cron, rate } from "@laranja/decorators";

export async function refreshCache() {
  // …
}

cron(rate(5, "minutes"), refreshCache);
```

The function's name becomes the resource id unless you pass an explicit `id`:

```ts
cron({ schedule: every("hour"), id: "hourly-sync" }, refreshCache);
```

## Schedules

Schedules are written with the portable `rate()` / `every()` builders, or as a
raw expression string. See the **[Schedules reference](./schedules.md)** for the
full set of options.

```ts
@Cron(rate(30, "minutes"))                 // every 30 minutes
@Cron(every("hour"))                       // every hour (shorthand for rate(1, "hour"))
@Cron({ schedule: "cron(0 9 * * ? *)" })   // raw AWS cron: 09:00 UTC daily
```

## Runtime behavior

- Each cron runs in its **own Lambda**, isolated from your HTTP app and other
  jobs.
- Function timeout: **60 seconds**.
- All [config `env`](../configuration/environment-variables.md) and `STAGE` are
  available via `process.env`.

## Related

- [Schedules](./schedules.md)
- [`@Cron` / `cron()` reference](../reference/decorators-and-markers.md#cron)
- [Queues](./queues.md)
