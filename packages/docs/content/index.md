---
title: Documentation
description: Code-first deploys for Node.js apps to your own cloud account.
order: 0
---

# laranja docs

**laranja** deploys your Node.js app to your own cloud account — **AWS or
Azure** — from your code. No YAML, no console clicking, no separate
infrastructure project. You write an Express or NestJS app plus a few functions
or decorators; laranja reads the code, figures out the infrastructure, and ships
it.

```bash
npm install -D @alzulejos/laranja
npx laranja deploy
```

## Start here

- **[Introduction](./getting-started/introduction.md)** — what laranja is and the ideas behind it.
- **[Installation](./getting-started/installation.md)** — prerequisites and setup.
- **[Quickstart](./getting-started/quickstart.md)** — from zero to a live URL.
- **[How it works](./getting-started/how-it-works.md)** — how your code becomes a running app in your account.

## Guides

- **[HTTP apps](./guides/http-apps.md)** — deploy your app behind a public URL with the `http()` marker.
- **[Cron jobs](./guides/cron-jobs.md)** — scheduled functions with `@Cron` / `cron()`.
- **[Queues](./guides/queues.md)** — queue consumers with `@Queue` / `queue()`, and producing with `getQueue()`.
- **[Schedules](./guides/schedules.md)** — the `rate()` / `every()` builders and raw expressions.
- **[Environment variables](./guides/environment-variables.md)** — `env`, `STAGE`, and resolution.
- **[Stages & environments](./guides/stages-and-environments.md)** — dev / staging / prod with one codebase.
- **[Deploying to Azure](./guides/deploying-to-azure.md)** — target your own Azure subscription, and what differs from AWS.
- **[Migrating from a PaaS](./guides/migrating-from-a-paas.md)** — move off Vercel, Railway, Render, or Heroku into your own account.

## Reference

- **[CLI commands](./reference/commands.md)** — `init`, `logout`, `plan`, `deploy`, `destroy`, `logs`, `eject`.
- **[Config file](./reference/config-file.md)** — every field in `laranja.config.ts`.
- **[Decorators & markers](./reference/decorators-and-markers.md)** — `@Cron`, `@Queue`, `cron`, `queue`, `http`, `env`.
- **[What gets deployed](./reference/what-gets-deployed.md)** — the resources laranja creates and how they're named.

> **Status:** **AWS** and **Azure** both run **Express** and **NestJS**, with HTTP,
> crons, queues, and environment variables ([Azure guide](./guides/deploying-to-azure.md)).
> FIFO queues are AWS-only. The internal model is provider- and framework-neutral,
> so new clouds and frameworks land without changing your app code.
