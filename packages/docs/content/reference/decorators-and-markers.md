---
title: Decorators & markers
description: API reference for @Cron, @Queue, cron, queue, and http.
order: 1
---

# Decorators & markers

All of these are imported from `@laranja/decorators`. They are **static markers**
— the [scanner](../concepts/how-it-works.md#1-scan) reads them at build time to
shape your infrastructure. At runtime they are near-no-ops (they don't wrap or
intercept your functions), so they're safe to leave in place.

```bash
npm install @laranja/decorators
```

The schedule builders [`rate`](../guides/schedules.md#ratevalue-unit) and
[`every`](../guides/schedules.md#everyunit) are re-exported here too, so you can
import them alongside `@Cron`.

---

## `@Cron`

Schedules a class method. Each `@Cron` becomes [its own Lambda + EventBridge
rule](../concepts/what-gets-deployed.md#cron--lambda--eventbridge-rule).

```ts
function Cron(schedule: ScheduleInput): MethodDecorator
function Cron(options: CronOptions): MethodDecorator
```

```ts
import { Cron, rate } from "@laranja/decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() {}

  @Cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" })
  async report() {}
}
```

**`CronOptions`**

| Field | Type | Description |
|---|---|---|
| `schedule` | `ScheduleInput` | A [`rate()`/`every()`](../guides/schedules.md) result, a `Schedule`, or a raw string. |
| `id` | `string` _(optional)_ | Stable logical id. Defaults to `‹Class›-‹method›`; also drives the Lambda name. |

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

## `@Queue`

Consumes messages from an SQS queue. Each `@Queue` becomes [an SQS queue +
consumer Lambda](../concepts/what-gets-deployed.md#queue--sqs-queue--consumer-lambda).
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
| `fifo` | `boolean` | `false` | Force a FIFO queue (or end `name` with `.fifo`). |

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

Marks the HTTP app (the proxy target) in code, as an alternative to setting
`entry`/`appExport` in config. Export the result so the scanner can find it.

```ts
function http<T>(app: T): T
```

```ts
import express from "express";
import { http } from "@laranja/decorators";

const app = express();
export default http(app);          // or: export const api = http(app);
```

It returns the app untouched — purely a static marker. Omit it (and `entry`) for
a [workers-only](../guides/http-apps.md#workers-only-deployments) deployment.

---

## Types

| Type | Description |
|---|---|
| `ScheduleInput` | `Schedule \| string` — anything accepted where a schedule is expected. |
| `Schedule` | Provider-neutral schedule: `{ kind: "rate", value, unit }` or `{ kind: "cron", expression, dialect }`. |
| `RateUnit` | `"minute" \| "minutes" \| "hour" \| "hours" \| "day" \| "days"`. |
| `JobHandler` | `(...args) => unknown \| Promise<unknown>` — a `cron()`/`queue()` handler. |

## Related

- [Cron jobs](../guides/cron-jobs.md) · [Queues](../guides/queues.md) · [Schedules](../guides/schedules.md)
- [HTTP apps](../guides/http-apps.md)
