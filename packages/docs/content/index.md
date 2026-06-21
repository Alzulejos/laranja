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
npm install -D @laranja/cli
npx laranja deploy
```

## Start here

- **[Introduction](./introduction.md)** — what laranja is and the ideas behind it.
- **[Installation](./getting-started/installation.md)** — prerequisites and setup.
- **[Quickstart](./getting-started/quickstart.md)** — from zero to a live URL.

## Concepts

- **[How it works](./concepts/how-it-works.md)** — how your code becomes a running app on AWS.
- **[What gets deployed](./concepts/what-gets-deployed.md)** — the AWS resources and how they're named.
- **[Stages & environments](./concepts/stages-and-environments.md)** — dev / staging / prod with one codebase.

## Configuration

- **[Config file](./configuration/config-file.md)** — every field in `laranja.config.ts`.
- **[Environment variables](./configuration/environment-variables.md)** — `env`, `STAGE`, and resolution.

## Guides

- **[HTTP apps](./guides/http-apps.md)** — deploy your app behind a public URL with the `http()` marker.
- **[Cron jobs](./guides/cron-jobs.md)** — scheduled functions with `@Cron` / `cron()`.
- **[Queues](./guides/queues.md)** — SQS consumers with `@Queue` / `queue()`.
- **[Schedules](./guides/schedules.md)** — the `rate()` / `every()` builders and raw expressions.

## Reference

- **[CLI commands](./cli/commands.md)** — `init`, `synth`, `deploy`, `diff`, `destroy`, `logs`, `eject`.
- **[Decorators & markers](./reference/decorators-and-markers.md)** — `@Cron`, `@Queue`, `cron`, `queue`, `http`, `env`.

> **Status:** v1 targets **AWS** with **Express** today; **NestJS support is
> coming**. The internal model is provider- and framework-neutral, so new clouds
> and frameworks land without changing your app code.
