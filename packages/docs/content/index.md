---
title: Documentation
description: Code-first deploys for Node.js apps to your own AWS account.
order: 0
---

# laranja docs

**laranja** deploys your Node.js app to your own AWS account from your code — no
YAML, no console clicking, no separate infrastructure project. You write an
Express app plus a few functions or decorators; laranja reads the code, figures
out the infrastructure, and ships it.

```bash
npm install -D @alzulejos/laranja
npx laranja deploy
```

## Start here

- **[Introduction](./getting-started/introduction.md)** — what laranja is and the ideas behind it.
- **[Installation](./getting-started/installation.md)** — prerequisites and setup.
- **[Quickstart](./getting-started/quickstart.md)** — from zero to a live URL.
- **[How it works](./getting-started/how-it-works.md)** — how your code becomes a running app on AWS.

## Guides

- **[HTTP apps](./guides/http-apps.md)** — deploy your app behind a public URL with the `http()` marker.
- **[Cron jobs](./guides/cron-jobs.md)** — scheduled functions with `@Cron` / `cron()`.
- **[Queues](./guides/queues.md)** — SQS consumers with `@Queue` / `queue()`.
- **[Schedules](./guides/schedules.md)** — the `rate()` / `every()` builders and raw expressions.
- **[Environment variables](./guides/environment-variables.md)** — `env`, `STAGE`, and resolution.
- **[Stages & environments](./guides/stages-and-environments.md)** — dev / staging / prod with one codebase.
- **[Deploying to Azure](./guides/deploying-to-azure.md)** — deploy an Express app + env to your own Azure subscription.

## Reference

- **[CLI commands](./reference/commands.md)** — `init`, `logout`, `plan`, `deploy`, `destroy`, `logs`, `eject`.
- **[Config file](./reference/config-file.md)** — every field in `laranja.config.ts`.
- **[Decorators & markers](./reference/decorators-and-markers.md)** — `@Cron`, `@Queue`, `cron`, `queue`, `http`, `env`.
- **[What gets deployed](./reference/what-gets-deployed.md)** — the AWS resources and how they're named.

> **Status:** **AWS** runs the full feature set — **Express** and **NestJS**, with
> HTTP, crons, and queues. **Azure** runs **Express** apps with **HTTP, crons, and
> environment variables** today ([guide](./guides/deploying-to-azure.md)); Azure
> queues and NestJS are a fast-follow. The internal model is provider- and
> framework-neutral, so new clouds and frameworks land without changing your app
> code.
