---
title: Introduction
description: What laranja is, the problem it solves, and the principles behind it.
order: 1
---

# Introduction

laranja is a **code-first deploy tool** for Node.js apps. You write your
application — an Express or NestJS app, some scheduled jobs, some queue consumers
— and laranja deploys it to **your own cloud account**. There is no
infrastructure project to maintain, no YAML to write, and no cloud console to
click through.

> laranja supports **Express** and **NestJS**, on **AWS** and **Azure** — the
> same app code either way. Internally your app is reduced to a framework- and
> provider-neutral description, so more of both can follow without changing how
> you write your code.

## The problem

Shipping a small Node service to the cloud usually means choosing between:

- **A platform** (managed hosting) — fast, but you don't own the infrastructure
  and you pay a markup to run in someone else's account.
- **Infrastructure-as-code** (CDK / Terraform / CloudFormation) — you own
  everything, but now you maintain a second codebase that drifts from the app it
  describes.

laranja takes a third path: **your application code _is_ the source of truth for
the infrastructure.** A route is an HTTP endpoint. A `@Cron` method is a
scheduled function. A `@Queue` method is a queue consumer. laranja reads those
facts out of your code and provisions exactly what they imply.

## How it feels

```ts
// src/app.ts — mark your HTTP app, code-first
import express from "express";
import { http } from "@alzulejos/laranja-decorators";

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));

export default http(app);
```

Jobs and queues come in two styles — plain **functions** or **classes** with
decorators. Use whichever you prefer:

```ts tab="Function"
// src/jobs.ts
import { cron, rate } from "@alzulejos/laranja-decorators";

export async function refreshCache() { /* ... */ }
cron(rate(5, "minutes"), refreshCache);
```

```ts tab="Class"
// src/jobs.ts
import { Cron, rate } from "@alzulejos/laranja-decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() { /* ... */ }
}
```

```bash
npx laranja deploy
```

You get a live HTTPS URL, a scheduled job, and a queue with a consumer — all in
your own account, named deterministically. See
[what gets deployed](../reference/what-gets-deployed.md) for the exact resources
on each provider.

## Principles

- **Code is the source of truth.** Infrastructure is _derived_ from the app, not
  declared alongside it. There's nothing to keep in sync.
- **Your account, your resources.** laranja deploys with your own cloud
  credentials into your account. You own every resource and can inspect it in the
  console.
- **Deterministic, no magic names.** Resources are named `‹app›-‹fn›-‹stage›` —
  predictable and greppable, with no random suffixes.
- **Provider-neutral by design.** The same app code deploys to **AWS** or
  **Azure** — you pick with one [`provider`](../reference/config-file.md#provider)
  field, not a rewrite. More clouds land the same way.
- **An escape hatch when you need it.** Outgrow the abstraction? `laranja eject`
  hands you a real, owned infrastructure project (see
  [eject](../reference/commands.md#eject)).

## What's in scope (v1)

| Capability | How you declare it |
|---|---|
| HTTP API | An Express or NestJS app, marked with the [`http()`](../reference/decorators-and-markers.md#http) marker. |
| Scheduled jobs | [`@Cron`](../reference/decorators-and-markers.md#cron) (class) or [`cron()`](../reference/decorators-and-markers.md#cron-marker) (function) |
| Queue consumers | [`@Queue`](../reference/decorators-and-markers.md#queue) (class) or [`queue()`](../reference/decorators-and-markers.md#queue-marker) (function) |
| Per-environment deploys | [Stages](../guides/stages-and-environments.md) (`--stage`) |
| Env vars | [`env`](../guides/environment-variables.md) in config |
| Target cloud | [`provider`](../reference/config-file.md#provider) — `"aws"` or `"azure"` |

Next: **[Installation](./installation.md)**.
