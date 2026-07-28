---
title: Deploying to Azure
description: Deploy an Express or NestJS app and its environment variables to your own Azure subscription.
order: 7
---

# Deploying to Azure

laranja can deploy to **your own Azure subscription** as an alternative to AWS.
The model is the same one you already know — you write the app, laranja reads the
code and ships the infrastructure — only the back half targets Azure instead.

> **What's supported today:** **Express** apps with **HTTP**, **crons** (`@Cron` /
> `cron()`), **queues** (`@Queue` / `queue()`, backed by Azure Storage Queues —
> [FIFO is AWS-only](#queues)), and **environment variables**. `http()` is **optional**
> — a **crons/queues-only** app (no HTTP endpoint) deploys just fine.
>
> **NestJS** apps get the same feature set, including class-based `@Cron` / `@Queue`
> providers resolved through a [`workers()`](../reference/decorators-and-markers.md#workers)
> dependency-injection root. FIFO queues remain AWS-only.

## Prerequisites

- **An Azure subscription** and a **resource group that already exists** — laranja
  deploys _into_ a group, it doesn't create one. Note the subscription id
  (`az account show --query id -o tsv`) and the group name.
- **Azure credentials** on the standard chain (`DefaultAzureCredential`): env
  vars, a managed identity, or `az login`. Locally, `az login` is enough; in CI,
  set a service principal via the `AZURE_*` environment variables.
- **A region that offers Flex Consumption** and is accepting new customers —
  `westus2` is a safe default. laranja runs your app on the Azure Functions
  **Flex Consumption** plan.

You do **not** need Bicep, ARM templates, or the Azure Functions Core Tools —
laranja synthesizes and submits the ARM deployment for you.

## Configure

Point your config at Azure and add the `azure` block:

```ts
// laranja.config.ts
import type { LaranjaConfig } from "@alzulejos/laranja-decorators";

const config: LaranjaConfig = {
  name: "my-api",
  projectId: "proj_…",
  provider: "azure",
  region: "westus2",
  azure: {
    subscriptionId: "00000000-0000-0000-0000-000000000000",
    resourceGroup: "my-existing-group",
  },
  env: { LOG_LEVEL: "info" },
};

export default config;
```

Or run [`laranja init`](../reference/commands.md#init), choose **Azure** when
prompted, and it fills in the subscription, group, and region for you.

See [`azure`](../reference/config-file.md#azure) in the config reference for the
field details.

## Deploy

Same commands as everywhere else:

```bash
npx laranja deploy
```

laranja provisions the infrastructure with an ARM deployment, then publishes your
app; when it finishes you get a public `https://‹app›.azurewebsites.net` URL.
[`plan`](../reference/commands.md#plan), [`logs`](../reference/commands.md#logs),
and [`destroy`](../reference/commands.md#destroy) all work against Azure too.

## Environment variables

[Environment variables](./environment-variables.md) work exactly as documented
there — the static `env` map, code-discovered `env("…")` values, `--strict`, and
the [secrets caveat](./environment-variables.md#secrets) all carry over
unchanged. The only Azure difference: they land in the Function App's
**application settings** rather than a Lambda's environment, and are read through
`process.env` the same way.

## Crons

[Cron jobs](./cron-jobs.md) work on Azure — declare them with `@Cron` or `cron()`
exactly as on AWS. The difference is structural: Azure hosts **one Function App
containing many functions**, so each cron becomes a **timer-triggered function
inside that same app** rather than its own isolated resource. Your HTTP proxy and
every cron are distinct functions sharing the app's compute, scaling, and identity.

Schedules are lowered to Azure's **NCRONTAB** format and stored as application
settings, so [changing a schedule](./schedules.md) is a config update rather than a
repackage. The portable `rate()` / `every()` builders work unchanged, and a raw
`cron(...)` expression is translated for you.

A few AWS-specific cron options don't map to an Azure timer and are **ignored with
a warning** — the deploy still succeeds:

- **`dlq`**, **`retryAttempts`**, **`maxEventAge`** come from Lambda's async-invoke
  model; an Azure timer has no queued event to retry, age out, or dead-letter. For
  at-least-once delivery with dead-lettering, reach for a [queue](#queues) rather
  than a timer.
- **Per-cron `timezone`** — Azure applies one timezone per Function App, so the
  first cron's timezone applies app-wide and a conflicting one warns.

## Queues

[Queues](./queues.md) work on Azure — declare a consumer with `@Queue` or `queue()`
and produce with [`getQueue().send()`](./queues.md#sending-messages), the same code
as on AWS. Each queue becomes an **Azure Storage Queue** plus a
**queue-triggered function** inside the one Function App (like crons, the consumer is
a function in the shared app, not its own isolated resource). Producing needs no
setup: the app's **managed identity** is granted access to the storage account, so
`getQueue("emails").send({ … })` just works — no connection string, no SAS.

The one real difference is **FIFO**. AWS SQS offers true FIFO queues (ordered,
deduplicated); **Azure Storage Queues do not** — they're best-effort ordering with
at-least-once delivery and no deduplication. laranja won't silently downgrade that
guarantee, so a `fifo: true` queue (or a `.fifo` name) is **rejected at
`plan`/`deploy` time** on Azure with a clear message. Use a standard queue, or deploy
that workload to AWS. (True FIFO on Azure means Service Bus, which is a future
option.)

### Dead-lettering

`dlq` works, by a different route than on AWS. A Storage Queue trigger can't
dead-letter to a queue _you_ name — the host always moves a message that fails
repeatedly to an automatic **`‹queue›-poison`** queue. That's a real queue, though, so
laranja binds an extra trigger on it that drains into the consumer you declared as the
`dlq`. Your handler receives the failures; only the queue they physically pass through
differs.

```ts
resources: {
  emails: { dlq: { queue: "emailsDLQ", maxReceiveCount: 3 } },
}
```

On Azure that deploys `emails`, `emailsDLQ`, and `emails-poison`, with `emailsDLQ`'s
consumer reading both its own queue and `emails-poison`. `emailsDLQ` stays a normal
queue you can [send to](#queues) directly.

Two limits worth knowing:

- **One `dlq` per queue.** If two queues name the _same_ `dlq`, laranja **won't** wire
  it up and warns instead — Azure gives each queue its own poison queue, and silently
  delivering one source's failures while dropping the other's would be worse than
  saying so. Give each queue its own `dlq` target.
- **`maxReceiveCount` is per Function App**, not per queue (it's the host-wide
  `maxDequeueCount`). Queues in the same app share one value; if two disagree, the first
  wins and the other is warned about. Since each [`workers()` root gets its own
  app](#nestjs-workers-on-azure), roots can carry different values.

A few AWS-specific queue options don't map to a Storage Queue trigger and are
**ignored with a warning** — the deploy still succeeds:

- **`visibilityTimeout`**, **`maxBatchingWindow`**, **`reportBatchItemFailures`**,
  **`messageRetention`** are SQS/event-source knobs with no per-queue Storage Queue
  equivalent, and **`batchSize`** is a host-wide setting on Azure (not per-queue).

## What gets deployed

A single **Function App** on the Flex Consumption plan hosts your app — the HTTP
proxy (if you declared `http()`), plus any crons and queue consumers, all as
functions in that same app — alongside the resources it needs, inside your resource
group:

- a **Function App** (`Microsoft.Web/sites`) + its Flex Consumption plan, hosting
  your HTTP proxy (when present), one **timer function per cron**, and one
  **queue-triggered function per queue** (crons and queues add no compute of their
  own — they're functions inside this app). A **crons/queues-only** app has no HTTP
  function; the app still gets a hostname, but nothing serves on it,
- a **storage account** for the deployment package **and your queues**
  (`Microsoft.Storage/…/queueServices/queues`, one per declared queue),
- **Application Insights** + a **Log Analytics workspace** that back
  [`laranja logs`](../reference/commands.md#logs).

Everything is named after your `name` and `stage`, and torn down together by
[`destroy`](../reference/commands.md#destroy).

### NestJS workers on Azure

If you use class-based `@Cron` / `@Queue` providers, one detail differs from AWS
and is worth knowing when you read your metrics.

On Azure a function is defined by its trigger — one function, one trigger — so a
[`workers()`](../reference/decorators-and-markers.md#workers) root with five crons
becomes **five functions**, not one. On AWS that same root becomes a single Lambda
that routes internally.

That isn't a downside. All those functions live in the one Function App and share a
single process, so laranja builds each root's DI container **once** and every trigger
belonging to it reuses that container — the same saving the AWS worker Lambda gets by
consolidating. You also get finer-grained telemetry than on AWS: each cron and queue
shows up as its own function in Application Insights and in
[`laranja logs`](../reference/commands.md#logs), rather than being pooled under one
worker.

Declaring several roots still keeps them apart: a trigger in one root never boots
another root's module. The one thing you don't get, unlike AWS's separate worker
Lambdas, is process isolation — all your functions share the app's process and memory.

## Related

- [Config file](../reference/config-file.md#azure)
- [Environment variables](./environment-variables.md)
- [HTTP apps](./http-apps.md)
