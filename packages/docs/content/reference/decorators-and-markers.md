---
title: Decorators & markers
description: API reference for @Cron, @Queue, cron, queue, and http.
order: 3
---

# Decorators & markers

All of these are imported from `@laranja/decorators`. They are **static markers**
— the [scanner](../getting-started/how-it-works.md#1-scan) reads them at build time to
shape your infrastructure. At runtime they are near-no-ops (they don't wrap or
intercept your functions), so they're safe to leave in place.

```bash
npm install @laranja/decorators
```

The schedule builders [`rate`](../guides/schedules.md#ratevalue-unit) and
[`every`](../guides/schedules.md#everyunit) are re-exported here too, so you can
import them alongside `@Cron`. For `@nestjs/schedule` compatibility, the
`CronExpression` enum, `@Interval`, and `@Timeout` are re-exported as well — so a
Nest app can repoint its import at `@laranja/decorators` unchanged.

---

## `@Cron`

Schedules a class method. Each `@Cron` becomes [its own Lambda + EventBridge
rule](./what-gets-deployed.md#cron--lambda--eventbridge-rule).

```ts
function Cron(schedule: ScheduleInput): MethodDecorator
function Cron(options: CronOptions): MethodDecorator
function Cron(expression: string, options?: NestCronOptions): MethodDecorator  // @nestjs/schedule form
```

```ts
import { Cron, rate, CronExpression } from "@laranja/decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() {}

  @Cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" })
  async report() {}

  // @nestjs/schedule style — a node-cron string or CronExpression, translated for you
  @Cron("0 3 * * *", { name: "nightly", timeZone: "Europe/Lisbon" })
  async nightly() {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep() {}
}
```

**`CronOptions`** (laranja form)

| Field | Type | Description |
|---|---|---|
| `schedule` | `ScheduleInput` | A [`rate()`/`every()`](../guides/schedules.md) result, a `Schedule`, or a raw string. |
| `id` | `string` _(optional)_ | Stable logical id. Defaults to `‹Class›-‹method›`; also drives the Lambda name. |

**`NestCronOptions`** (the second argument in the `@nestjs/schedule` form)

| Field | Type | Description |
|---|---|---|
| `name` | `string` _(optional)_ | Used as the resource `id`. |
| `timeZone` | `string` _(optional)_ | IANA timezone the schedule is evaluated in. |

See [Schedules → node-cron expressions](../guides/schedules.md#node-cron-expressions-nestjsschedule-compatibility)
for the accepted syntax and what's rejected. Nest providers resolve through DI —
declare your module with [`workers()`](#workers).

---

## `cron()` marker

Function-style counterpart to `@Cron`, for codebases that don't use classes.
Registers a standalone exported function on a schedule.

```ts
function cron(schedule: ScheduleInput, handler: JobHandler): void
function cron(options: CronOptions, handler: JobHandler): void
```

```ts
import { cron, rate } from "@laranja/decorators";

export async function refreshCache() {}

cron(rate(5, "minutes"), refreshCache);
cron({ schedule: rate(1, "hour"), id: "hourly-sync" }, refreshCache);
```

The function's name becomes the resource id unless you pass an explicit `id`.

---

## `@Interval`

`@nestjs/schedule`-compatible. Runs a method every _N_ milliseconds; laranja
lowers it to a `rate(...)`, so the interval must be a whole number of minutes
(EventBridge's 1-minute floor).

```ts
function Interval(milliseconds: number): MethodDecorator
function Interval(name: string, milliseconds: number): MethodDecorator
```

```ts
import { Interval } from "@laranja/decorators";

export class Jobs {
  @Interval(300000)          // every 5 minutes
  async poll() {}
}
```

---

## `@Timeout`

Re-exported for `@nestjs/schedule` source compatibility, but a one-shot timer
relative to process start has no serverless equivalent — laranja **rejects it at
build time** with a clear message. Use [`@Cron`](#cron) or [`@Interval`](#interval)
instead.

---

## `@Queue`

Consumes messages from an SQS queue. Each `@Queue` becomes [an SQS queue +
consumer Lambda](./what-gets-deployed.md#queue--sqs-queue--consumer-lambda).
The handler is called once per message with the JSON-parsed body.

```ts
function Queue(options: QueueOptions): MethodDecorator
```

```ts
import { Queue } from "@laranja/decorators";

export class Workers {
  @Queue({ name: "emails", batchSize: 10 })
  async sendEmail(body: unknown) {}

  @Queue({ name: "orders.fifo", fifo: true })
  async processOrder(body: unknown) {}
}
```

**`QueueOptions`**

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | _required_ | Queue name. A `.fifo` suffix marks a FIFO queue. |
| `batchSize` | `number` | `10` | Max messages per consumer invocation. |
| `fifo` | `boolean` | `false` | Force a FIFO queue (or end `name` with `.fifo`). When set, laranja appends `.fifo` to `name` if you left it off. |

---

## `queue()` marker

Function-style counterpart to `@Queue`.

```ts
function queue(options: QueueOptions, handler: JobHandler): void
```

```ts
import { queue } from "@laranja/decorators";

export async function sendEmail(body: unknown) {}

queue({ name: "emails", batchSize: 10 }, sendEmail);
```

---

## `http()`

Marks the HTTP app (the proxy target) in code — the only way to declare one.
Export the result so the scanner can find it.

```ts
function http<T>(app: T): T
```

```ts
import express from "express";
import { http } from "@laranja/decorators";

const app = express();
export default http(app);          // or: export const api = http(app);
```

It returns its argument untouched — purely a static marker. Omit it for a
[workers-only](../guides/http-apps.md#workers-only-deployments) deployment.

For **NestJS**, wrap your async `bootstrap` factory (which `return`s the app)
instead of an app instance — see [HTTP apps → NestJS](../guides/http-apps.md#nestjs):

```ts
export default http(bootstrap);    // bootstrap: () => Promise<INestApplication>
```

---

## `workers()`

**NestJS only.** Declares the module laranja builds a dependency-injection
context from, so class-based [`@Cron`](#cron) / [`@Queue`](#queue) providers
resolve their injected dependencies at runtime (via
`NestFactory.createApplicationContext`) instead of a bare `new`. The DI
counterpart to [`http()`](#http); export it so the scanner can find it.

```ts
function workers<T>(module: T): T
```

```ts
import { workers } from "@laranja/decorators";
import { AppModule } from "./app.module";

export default workers(AppModule);   // or: export const jobs = workers(AppModule);
```

Pass `AppModule` for the whole graph, or a leaner module for a smaller cold
start. There's exactly one per project. Required when a Nest project has
class-based workers; standalone [`cron()`](#cron-marker)/[`queue()`](#queue-marker)
functions don't need it (no DI). Returns its argument untouched — a static marker.

---

## `env()`

Declares an environment variable your code needs. At runtime it just returns
`process.env[name]`; laranja discovers each call and populates that variable on
every deployed function, with the value supplied from your shell or CI at deploy
time.

```ts
function env(name: string): string | undefined
```

```ts
import { env } from "@laranja/decorators";

const dbUrl = env("DATABASE_URL");
```

The name must be a **string literal** so it can be found statically. See
[environment variables](../guides/environment-variables.md#values-from-your-environment--env)
for supplying values, the `--strict` flag, and per-stage usage.

---

## Types

| Type | Description |
|---|---|
| `ScheduleInput` | `Schedule \| string` — anything accepted where a schedule is expected. |
| `Schedule` | Provider-neutral schedule: `{ kind: "rate", value, unit }` or `{ kind: "cron", expression, dialect }`. |
| `RateUnit` | `"minute" \| "minutes" \| "hour" \| "hours" \| "day" \| "days"`. |
| `CronExpression` | Enum of common cron strings, mirrored from `@nestjs/schedule`. |
| `JobHandler` | `(...args) => unknown \| Promise<unknown>` — a `cron()`/`queue()` handler. |

## Related

- [Cron jobs](../guides/cron-jobs.md) · [Queues](../guides/queues.md) · [Schedules](../guides/schedules.md)
- [HTTP apps](../guides/http-apps.md)
