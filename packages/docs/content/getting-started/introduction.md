---
title: Introduction
description: What laranja is, the problem it solves, and the principles behind it.
order: 1
---

# Introduction

laranja is a **code-first deploy tool** for Node.js apps. You write your
application — an Express app, some scheduled jobs, some queue consumers — and
laranja deploys it to **your own AWS account**. There is no infrastructure
project to maintain, no YAML to write, and no cloud console to click through.

> laranja supports **Express** today. **NestJS support is coming** — and because
> your app is reduced to a framework-neutral description internally, it'll work
> without changing how you write your code.

## The problem

Shipping a small Node service to AWS usually means choosing between:

- **A platform** (managed hosting) — fast, but you don't own the infrastructure
  and you pay a markup to run in someone else's account.
- **Infrastructure-as-code** (CDK / Terraform / CloudFormation) — you own
  everything, but now you maintain a second codebase that drifts from the app it
  describes.

laranja takes a third path: **your application code _is_ the source of truth for
the infrastructure.** A route is an HTTP endpoint. A `@Cron` method is a
scheduled function. A `@Queue` method is an SQS consumer. laranja reads those
facts out of your code and provisions exactly what they imply.

## How it feels

```ts
// src/app.ts — mark your HTTP app, code-first
import express from "express";
import { http } from "@laranja/decorators";

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));

export default http(app);
```

Jobs and queues come in two styles — plain **functions** or **classes** with
decorators. Use whichever you prefer:

```ts tab="Function"
// src/jobs.ts
import { cron, rate } from "@laranja/decorators";

export async function refreshCache() { /* ... */ }
cron(rate(5, "minutes"), refreshCache);
```

```ts tab="Class"
// src/jobs.ts
import { Cron, rate } from "@laranja/decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() { /* ... */ }
}
```

```bash
npx laranja deploy
```

You get a live HTTPS URL, an EventBridge schedule, and an SQS queue with a
consumer — all in your own account, named deterministically.

## Principles

- **Code is the source of truth.** Infrastructure is _derived_ from the app, not
  declared alongside it. There's nothing to keep in sync.
- **Your account, your resources.** laranja deploys with your AWS credentials
  into your account. You own every resource and can inspect it in the console.
- **Deterministic, no magic names.** Resources are named `‹app›-‹fn›-‹stage›` —
  predictable and greppable, with no random suffixes.
- **Provider-neutral by design.** AWS is the first target, but laranja is built
  so other clouds can follow without changing your app code.
- **An escape hatch when you need it.** Outgrow the abstraction? `laranja eject`
  hands you a real, owned CDK project (see [eject](../reference/commands.md#eject)).

## What's in scope (v1)

| Capability | How you declare it |
|---|---|
| HTTP API | An Express app, marked with the [`http()`](../reference/decorators-and-markers.md#http) marker. NestJS coming. |
| Scheduled jobs | [`@Cron`](../reference/decorators-and-markers.md#cron) (class) or [`cron()`](../reference/decorators-and-markers.md#cron-marker) (function) |
| Queue consumers | [`@Queue`](../reference/decorators-and-markers.md#queue) (class) or [`queue()`](../reference/decorators-and-markers.md#queue-marker) (function) |
| Per-environment deploys | [Stages](../guides/stages-and-environments.md) (`--stage`) |
| Env vars | [`env`](../guides/environment-variables.md) in config |

Next: **[Installation](./installation.md)**.
