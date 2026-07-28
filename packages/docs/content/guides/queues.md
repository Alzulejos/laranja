---
title: Queues
description: Process queue messages with @Queue or queue(), including FIFO.
order: 3
---

# Queues

A queue consumer processes messages from a queue. Each one becomes
[a queue plus a consumer function](../reference/what-gets-deployed.md#queue--a-queue--a-consumer-function)
— SQS on AWS, an Azure Storage Queue on Azure. The same `@Queue` / `queue()` and
`getQueue().send()` code works on both; **FIFO** is the one capability that
differs.

| Capability | AWS (SQS) | Azure (Storage Queue) |
|---|---|---|
| Standard queues | ✅ | ✅ |
| `getQueue().send()` producer | ✅ | ✅ |
| `delaySeconds` on send | ✅ | ✅ (message visibility delay) |
| FIFO (`fifo` / `.fifo`, ordering, dedup) | ✅ | ❌ rejected at `plan`/`deploy` |
| Dead-letter queue | ✅ `dlq` (queue you name) | ⚠️ automatic `‹queue›-poison` |
| `batchSize`, `visibilityTimeout`, `messageRetention` | ✅ per-queue | ⚠️ ignored (host-wide or N/A) |

The Azure column is detailed in
[Deploying to Azure → Queues](./deploying-to-azure.md#queues); everything else on
this page applies to both.

## Class style — `@Queue`

Decorate a method with [`@Queue`](../reference/decorators-and-markers.md#queue):

```ts
import { Queue } from "@alzulejos/laranja-decorators";

export class Workers {
  @Queue({ name: "emails", batchSize: 10 })
  async sendEmail(body: unknown) {
    // `body` is the JSON-parsed message
  }
}
```

## Function style — `queue()`

```ts
import { queue } from "@alzulejos/laranja-decorators";

export async function sendEmail(body: unknown) {
  // …
}

queue({ name: "emails", batchSize: 10 }, sendEmail);
```

## NestJS

`@Queue` works on a Nest provider with injected dependencies. As with
[cron jobs](./cron-jobs.md#nestjs), laranja resolves the consumer through your
DI container, so declare your module once with the
[`workers()`](../reference/decorators-and-markers.md#workers) marker
(`export default workers(AppModule)`) and deploy your compiled `dist/` output.
Standalone `queue()` functions don't need it.

## Options

| Option | Default | Description |
|---|---|---|
| `name` | _required_ | Queue name. A `.fifo` suffix marks a FIFO queue. |
| `batchSize` | `10` | Max messages delivered to the consumer per invocation. |
| `fifo` | `false` | Force a FIFO queue (or end `name` with `.fifo`). When set, laranja appends `.fifo` to `name` if you left it off. |

## How messages are delivered

- Your handler is invoked **once per message**, with the message **body already
  JSON-parsed**.
- **Partial-batch failures** are enabled: if your handler throws for one message,
  only that message is retried — the rest of the batch is still acknowledged.
- Consumer memory/timeout come from [`compute`](../reference/config-file.md#compute);
  on AWS the queue's visibility timeout is derived to stay ≥ the consumer timeout
  (override it per queue via [`resources`](../reference/config-file.md#resources)).

```ts
@Queue({ name: "orders" })
async processOrder(body: unknown) {
  const order = body as { id: string };
  if (!order.id) throw new Error("bad message"); // only THIS message is retried
  // …
}
```

## FIFO queues

> **AWS only.** Azure Storage Queues have no ordering or deduplication, so a FIFO
> queue is rejected at `plan`/`deploy` time there rather than silently downgraded.

End the name with `.fifo` (or set `fifo: true`) for ordered, exactly-once
processing. Content-based deduplication is enabled automatically:

```ts
@Queue({ name: "orders.fifo", fifo: true })
async processOrder(body: unknown) {
  // …
}
```

AWS requires FIFO queue names to end in `.fifo`. If you set `fifo: true` but
leave the suffix off, laranja appends it for you — so `{ name: "orders", fifo: true }`
deploys a queue named `orders.fifo`. The normalized name is what appears in
`laranja plan` and in the AWS console, so there's no surprise at deploy time.

## Sending messages

Consuming is only half the loop — to **produce** a message, call
[`getQueue`](../reference/decorators-and-markers.md#getqueue) with the queue's
`name` and `.send()` a payload:

```ts
import { getQueue } from "@alzulejos/laranja-decorators";

app.post("/signup", async (req, res) => {
  await getQueue("emails").send({ to: req.body.email, template: "welcome" });
  res.sendStatus(202);
});
```

Objects are JSON-serialized for you (strings are sent as-is), so the consumer
receives them already parsed — `getQueue("emails").send({ to })` on one end,
`async sendEmail(body)` on the other.

You can produce from **anywhere** in a deployed app — an HTTP route, a
[cron job](./cron-jobs.md), or another queue's consumer fanning out. laranja wires
every function to send at deploy — on AWS it injects each queue's URL and grants
`sqs:SendMessage`; on Azure it uses the app's managed identity against the storage
account — so there's no client to configure, no URL to look up, and no IAM to wire.
It's a thin wrapper over one `SendMessage` call — laranja provisions the
infrastructure; it deliberately does **not** add a job framework (retries,
scheduling, and job state stay with the queue and your consumer).

### FIFO and options

`.send()` takes a second options argument:

| Option | Applies to | Description |
|---|---|---|
| `groupId` | FIFO (**required**) | `MessageGroupId` — messages with the same group are ordered. |
| `dedupId` | FIFO | `MessageDeduplicationId` — only needed when content-based dedup is off. |
| `delaySeconds` | Standard | Delay (0–900s) before the message becomes visible. Ignored by FIFO. |

```ts
// FIFO queues require a groupId — the send throws without one.
await getQueue("orders.fifo").send(order, { groupId: order.customerId });
```

> Prefer the raw SDK? The queue is a plain queue in your account — on AWS its URL
> is emitted as a stack output, so you can send with `@aws-sdk/client-sqs`
> directly if you'd rather.

## Related

- [`@Queue` / `queue()` reference](../reference/decorators-and-markers.md#queue)
- [What gets deployed](../reference/what-gets-deployed.md#queue--a-queue--a-consumer-function)
- [Cron jobs](./cron-jobs.md) · [Deploying to Azure](./deploying-to-azure.md#queues)
