---
title: Environment variables
description: How env vars are declared, injected, and resolved across stages.
order: 2
---

# Environment variables

Every Lambda laranja deploys receives a set of environment variables, available
through `process.env` as usual.

## Declaring env vars

Put plain values in the `env` map in your config. They're injected into **every**
function (HTTP proxy, cron, and queue consumers):

```ts
// laranja.config.ts
const config: LaranjaConfig = {
  name: "my-api",
  entry: "src/app.ts",
  env: {
    LOG_LEVEL: "info",
    API_BASE_URL: "https://api.example.com",
  },
};
```

```ts
// anywhere in your app
const level = process.env.LOG_LEVEL; // "info"
```

The `env` map holds **literal values** that are safe to commit. Use it for
non-sensitive configuration: log levels, public URLs, feature flags.

## The `STAGE` variable

laranja always injects `STAGE`, set to the active [stage](../concepts/stages-and-environments.md)
(`"dev"` by default, or whatever `--stage` resolved to). You don't declare it:

```ts
app.get("/", (_req, res) => res.json({ stage: process.env.STAGE }));
```

If you also define `STAGE` in `env`, your value wins.

## Per-stage values

Because [`--stage`](../concepts/stages-and-environments.md) selects the
environment at deploy time, the common pattern is one pipeline per stage, each
supplying its own values. The recommended split:

- **Non-sensitive, shared defaults** → the `env` map in config.
- **Per-environment values** → provide them from the deploy environment (your
  CI's environment variables) so each pipeline injects the right ones for its
  stage.

```bash
# dev pipeline
LOG_LEVEL=debug laranja deploy --stage dev
# prod pipeline
LOG_LEVEL=warn  laranja deploy --stage prod
```

> **Heads-up:** declare the keys you actually use. laranja injects the env you
> configure — it does not vacuum your machine's or CI runner's entire
> environment into the Lambda.

## Secrets

Sensitive values (API keys, DB passwords) are a separate concern from plain
`env` — they shouldn't live in your repo or in a Lambda's plain environment.
First-class secrets support is on the roadmap; until then, the recommended
approach is to read them at runtime from a secret store (e.g. AWS SSM Parameter
Store / Secrets Manager) within your handler.

## Related

- [Config file](./config-file.md)
- [Stages & environments](../concepts/stages-and-environments.md)
