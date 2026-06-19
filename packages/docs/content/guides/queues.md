---
title: Queues
description: Process SQS messages with @Queue or queue(), including FIFO.
order: 3
---

# Queues

A queue consumer processes messages from an SQS queue. Each one becomes
[an SQS queue plus a consumer Lambda](../concepts/what-gets-deployed.md#queue--sqs-queue--consumer-lambda).

## Class style — `@Queue`

Decorate a method with [`@Queue`](../reference/decorators-and-markers.md#queue):

```ts
import { Queue } from "@laranja/decorators";

export class Workers {
  @Queue({ name: "emails", batchSize: 10 })
  async sendEmail(body: unknown) {
    // `body` is the JSON-parsed message
  }
}
```

## Function style — `queue()`

```ts
import { queue } from "@laranja/decorators";

export async function sendEmail(body: unknown) {
  // …
}

queue({ name: "emails", batchSize: 10 }, sendEmail);
```

## Options

| Option | Default | Description |
|---|---|---|
| `name` | _required_ | Queue name. A `.fifo` suffix marks a FIFO queue. |
| `batchSize` | `10` | Max messages delivered to the consumer per invocation. |
| `fifo` | `false` | Force a FIFO queue (or end `name` with `.fifo`). |

## How messages are delivered

- Your handler is invoked **once per message**, with the message **body already
  JSON-parsed**.
- **Partial-batch failures** are enabled: if your handler throws for one message,
  only that message is retried — the rest of the batch is still acknowledged.
- Consumer timeout: **30 seconds**. The queue's visibility timeout is set to 6×
  the consumer timeout automatically.

```ts
@Queue({ name: "orders" })
async processOrder(body: unknown) {
  const order = body as { id: string };
  if (!order.id) throw new Error("bad message"); // only THIS message is retried
  // …
}
```

## FIFO queues

End the name with `.fifo` (or set `fifo: true`) for ordered, exactly-once
processing. Content-based deduplication is enabled automatically:

```ts
@Queue({ name: "orders.fifo", fifo: true })
async processOrder(body: unknown) {
  // …
}
```

## Sending messages

laranja provisions the queue and consumer; **producing** messages is up to your
app. Send to the queue with the AWS SDK (`@aws-sdk/client-sqs`) using the queue
URL — emitted as a stack output after deploy and visible in the AWS console.

## Related

- [`@Queue` / `queue()` reference](../reference/decorators-and-markers.md#queue)
- [What gets deployed](../concepts/what-gets-deployed.md#queue--sqs-queue--consumer-lambda)
- [Cron jobs](./cron-jobs.md)
