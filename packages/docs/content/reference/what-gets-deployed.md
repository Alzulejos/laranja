---
title: What gets deployed
description: The exact AWS resources laranja creates and how they're named.
order: 4
---

# What gets deployed

laranja maps each thing it finds in your code to a small, predictable set of AWS
resources — all in your own account.

## HTTP app → proxy Lambda + Function URL

Your entire Express app is deployed as **one Lambda function** fronted by a
**Lambda Function URL**. There is no API Gateway.

- All routes are served by this single proxy Lambda.
- The Function URL is **public** (`authType: NONE`) and CORS is open
  (`*` origins, all methods, all headers) — your app handles auth/CORS as it
  sees fit.
- Memory and timeout come from [`compute`](./config-file.md#compute)
  in your config (the scaffold sets `{ memory: 256, timeout: 30 }`), overridable
  per-resource under the `http` key in [`resources`](./config-file.md#resources).
- The public HTTPS URL is emitted as the `HttpUrl` stack output.

```
GET  https://‹id›.lambda-url.‹region›.on.aws/
```

## `@Cron` → Lambda + EventBridge rule

Each cron handler becomes **its own Lambda** plus an **EventBridge rule** that
invokes it on schedule.

- Memory and timeout come from [`compute`](./config-file.md#compute)
  (default `{ memory: 256, timeout: 30 }`), overridable per cron id in
  [`resources`](./config-file.md#resources).
- The schedule comes from your [`rate()`/`every()`](../guides/schedules.md)
  builder or raw expression.

## `@Queue` → SQS queue + consumer Lambda

Each queue handler becomes an **SQS queue** and a **consumer Lambda** wired to it.

- Encryption: **SQS-managed (SSE-SQS)**.
- **FIFO** queues are created when the name ends in `.fifo` or `fifo: true` is
  set (content-based deduplication is enabled for FIFO).
- Default **batch size**: 10. Your handler is invoked per message with the
  JSON-parsed body.
- **Partial-batch failures** are enabled: throwing for one message fails only
  that message; the rest of the batch still succeeds.
- Consumer memory/timeout come from [`compute`](./config-file.md#compute)
  (default `{ memory: 256, timeout: 30 }`). The queue's **visibility timeout** is
  derived to satisfy AWS's rule that it be ≥ the consumer timeout, and can be set
  explicitly per queue via [`resources`](./config-file.md#resources).
- The queue URL is emitted as a stack output.

## Naming

Everything is named deterministically — no random suffixes:

| Resource | Pattern | Example |
|---|---|---|
| CloudFormation stack | `‹name›-‹stage›` | `my-api-prod` |
| Lambda functions | `‹name›-‹fn›-‹stage›` | `my-api-app-prod`, `my-api-sendEmail-prod` |

`‹fn›` is the handler's name (the method/function name), or the explicit `id` you
set on `@Cron`/`@Queue`. The HTTP proxy uses `app`. Names are truncated to AWS's
64-character limit and sanitized to allowed characters.

Because the stage is part of the names, multiple stages can live in one account
without colliding — see [Stages & environments](../guides/stages-and-environments.md).

## Supporting resources

Each Lambda gets an **IAM execution role** (and the queue consumers get the
permissions to read their queue / EventBridge to invoke crons). The first deploy
to an account/region also creates the one-time CDK **bootstrap** resources (an S3
asset bucket and roles).

## Related

- [How it works](../getting-started/how-it-works.md)
- [HTTP apps](../guides/http-apps.md) · [Cron jobs](../guides/cron-jobs.md) · [Queues](../guides/queues.md)
