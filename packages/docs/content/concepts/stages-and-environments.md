---
title: Stages & environments
description: Run dev, staging, and prod from one codebase with --stage.
order: 3
---

# Stages & environments

A **stage** is a named environment — `dev`, `staging`, `prod`, or anything you
like. laranja makes each stage a fully independent deployment from the same
codebase.

## Setting the stage

The default stage is `dev`. Set it in config:

```ts
// laranja.config.ts
const config: LaranjaConfig = { name: "my-api", entry: "src/app.ts", stage: "dev" };
```

…or override it per command with `--stage` (alias `-s`):

```bash
laranja deploy --stage prod
laranja deploy -s staging
```

The flag wins over the config value, which is why the recommended setup keeps
`stage` at its default in config and lets each pipeline pass `--stage`.

`--stage` applies to every environment-aware command: `deploy`, `synth`, `diff`,
`destroy`, `logs`, and `eject`.

## Each stage is its own stack

The stage is part of the **stack name** (`‹name›-‹stage›`) and every resource
name (`‹name›-‹fn›-‹stage›`). So `--stage dev` and `--stage prod` produce two
**independent CloudFormation stacks** that never collide — even in the same AWS
account.

```
my-api-dev     ← laranja deploy --stage dev
my-api-prod    ← laranja deploy --stage prod
```

## Two ways to isolate environments

Both work, and they compose:

1. **One account, multiple stages.** The stage suffix keeps the stacks separate.
   Good for small projects or non-prod environments.
2. **Separate accounts per stage.** Point each pipeline at different AWS
   credentials (a dev account and a prod account). Here your **AWS credentials
   are the real boundary**; the stack name can even repeat across accounts
   without conflict.

## One pipeline per stage

The canonical CI/CD setup is one pipeline per environment, each running the same
command with a different flag:

```yaml
# dev pipeline       → laranja deploy --stage dev
# staging pipeline   → laranja deploy --stage staging
# prod pipeline      → laranja deploy --stage prod
```

Same repo, same command — only the flag differs. No per-environment config files
to keep in sync. Pair this with [per-stage env values](../configuration/environment-variables.md#per-stage-values)
to supply each environment's configuration.

> Consistency matters: a pipeline's `destroy`, `logs`, and `diff` must use the
> **same `--stage`** as its `deploy`, or they'll target a different stack.

## The `STAGE` env var

The active stage is injected into every Lambda as `process.env.STAGE`, so your
code can branch on it:

```ts
const isProd = process.env.STAGE === "prod";
```

## Related

- [Config file](../configuration/config-file.md)
- [Environment variables](../configuration/environment-variables.md)
