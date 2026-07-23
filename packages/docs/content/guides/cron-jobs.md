---
title: Cron jobs
description: Run functions on a schedule with @Cron or cron().
order: 2
---

# Cron jobs

A cron job is a function that runs on a schedule. On AWS each one becomes
[its own Lambda plus an EventBridge rule](../reference/what-gets-deployed.md#cron--lambda--eventbridge-rule).

> On **Azure**, the same `@Cron` / `cron()` code deploys as a **timer function
> inside your one Function App** instead — see
> [Deploying to Azure](./deploying-to-azure.md#crons) for the differences.

## Class style — `@Cron`

Decorate a method with [`@Cron`](../reference/decorators-and-markers.md#cron) and
give it a [schedule](./schedules.md):

```ts
import { Cron, rate, every } from "@alzulejos/laranja-decorators";

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
import { cron, rate } from "@alzulejos/laranja-decorators";

export async function refreshCache() {
  // …
}

cron(rate(5, "minutes"), refreshCache);
```

The function's name becomes the resource id unless you pass an explicit `id`:

```ts
cron({ schedule: every("hour"), id: "hourly-sync" }, refreshCache);
```

## NestJS

In a Nest app, `@Cron` goes on a normal provider — with injected dependencies —
and you can keep the schedule syntax you already use (a
[node-cron string or `CronExpression`](./schedules.md#node-cron-expressions-nestjsschedule-compatibility)).
Swapping the import from `@nestjs/schedule` is usually the only change:

```ts
// tasks.service.ts
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@alzulejos/laranja-decorators";  // ← was @nestjs/schedule

@Injectable()
export class TasksService {
  constructor(private readonly reports: ReportsService) {}   // real DI

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep() {
    await this.reports.rebuild();   // `this.reports` is injected
  }
}
```

Because the method runs on a real provider, laranja resolves it through your
app's dependency-injection container instead of `new`-ing the class. Point it at
your module **once** with the [`workers()`](../reference/decorators-and-markers.md#workers)
marker:

```ts
// src/main.ts (or a dedicated file)
import { workers } from "@alzulejos/laranja-decorators";
import { AppModule } from "./app.module";

export default workers(AppModule);   // build a DI context from this module
```

Pass `AppModule` for the whole graph, or a leaner module you compose if you want
a smaller cold start. Like the Nest [HTTP path](./http-apps.md#nestjs), laranja
packages your **compiled** `dist/` output — run `nest build` before deploying so
the DI metadata exists.

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
- Memory and timeout come from [`compute`](../reference/config-file.md#compute)
  (default `{ memory: 256, timeout: 30 }`) and can be overridden per cron id in
  [`resources`](../reference/config-file.md#resources).
- All [config `env`](./environment-variables.md) and `STAGE` are
  available via `process.env`.

## Related

- [Schedules](./schedules.md)
- [`@Cron` / `cron()` reference](../reference/decorators-and-markers.md#cron)
- [Queues](./queues.md)
