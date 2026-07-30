---
title: Stages & environments
seoTitle: Deploy dev, staging, and prod from one codebase
description: Run fully independent dev, staging, and prod deployments from the same codebase with --stage. Each stage gets its own resources and its own environment variable values.
order: 6
---

# Stages & environments

To run separate environments, pass `--stage` (or set it in config): every stage
is a **fully independent deployment** from the same codebase, with its own
functions, queues, schedules, and environment variable values. `dev`, `staging`,
`prod`, or any name you like — nothing is shared between them.

## Setting the stage

The default stage is `dev`. Set it in config:

```ts
// laranja.config.ts
const config: LaranjaConfig = { name: "my-api", stage: "dev" };
```

…or override it per command with `--stage` (alias `-s`):

```bash
laranja deploy --stage prod
laranja deploy -s staging
```

The flag wins over the config value, which is why the recommended setup keeps
`stage` at its default in config and lets each pipeline pass `--stage`.

`--stage` applies to every environment-aware command: `deploy`, `plan`,
`destroy`, `logs`, and `eject`.

## Each stage is its own stack

The stage is part of the **deployment name** (`‹name›-‹stage›`) and every resource
name (`‹name›-‹fn›-‹stage›`). So `--stage dev` and `--stage prod` produce two
**fully independent deployments** that never collide — even in the same account.
(On AWS that's two CloudFormation stacks; on Azure, two independently-named sets
of resources in your group.)

```
my-api-dev     ← laranja deploy --stage dev
my-api-prod    ← laranja deploy --stage prod
```

## Two ways to isolate environments

Both work, and they compose:

1. **One account, multiple stages.** The stage suffix keeps the deployments
   separate. Good for small projects or non-prod environments.
2. **Separate accounts per stage.** Point each pipeline at different cloud
   credentials (a dev and a prod AWS account, or two Azure subscriptions /
   resource groups). Here your **credentials are the real boundary**; the names
   can even repeat across accounts without conflict.

## One pipeline per stage

The canonical CI/CD setup is one pipeline per environment, each running the same
command with a different flag:

```yaml
# dev pipeline       → laranja deploy --stage dev
# staging pipeline   → laranja deploy --stage staging
# prod pipeline      → laranja deploy --stage prod
```

Same repo, same command — only the flag differs. No per-environment config files
to keep in sync. Pair this with [per-stage env values](./environment-variables.md#per-stage-values)
to supply each environment's configuration.

> Consistency matters: a pipeline's `destroy`, `logs`, and `plan` must use the
> **same `--stage`** as its `deploy`, or they'll target a different stack.

## The `STAGE` env var

The active stage is injected into every deployed function as `process.env.STAGE`,
so your code can branch on it:

```ts
const isProd = process.env.STAGE === "prod";
```

## Related

- [Config file](../reference/config-file.md)
- [Environment variables](./environment-variables.md)
