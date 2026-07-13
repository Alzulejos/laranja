---
title: Environment variables
description: Declare env vars in config or in code, and supply their values per stage.
order: 5
---

# Environment variables

Every Lambda laranja deploys receives a set of environment variables, available
through `process.env` as usual. There are two ways to declare them.

## Static values in config

Put plain, commit-safe values in the `env` map in your config. They're injected
into **every** function (HTTP proxy, cron, and queue consumers):

```ts
// laranja.config.ts
const config: LaranjaConfig = {
  name: "my-api",
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

Use this for non-sensitive configuration that's the same everywhere: log levels,
public URLs, feature flags.

## Values from your environment — `env()`

When a value should come from your shell or CI instead of your repo, wrap the
variable name with the `env()` helper where you read it:

```ts
import { env } from "@alzulejos/laranja-decorators";

const dbUrl = env("DATABASE_URL"); // same as process.env.DATABASE_URL at runtime
```

laranja finds every `env("…")` in your code and makes sure that variable is set
on **every** deployed function — no more filling them in by hand in the AWS
console. At deploy time it reads each value from your own environment and sends
it straight to the function; the value is never written into your repo.

The name must be a **string literal** — `env("DATABASE_URL")`, not
`env(someVariable)` — so laranja can discover it just by reading your code.

### Supplying the values

Set the variables in the shell or CI job you deploy from:

```bash
DATABASE_URL=postgres://… laranja deploy --stage prod
```

- **Missing a value?** By default laranja deploys anyway and warns you which ones
  were empty — a typo never blocks a deploy. Pass `--strict` to fail the deploy
  instead.
- **Re-deploying without re-supplying a value?** The previously deployed value is
  kept, so you don't have to pass every variable on every deploy.

## The `STAGE` variable

laranja always injects `STAGE`, set to the active [stage](./stages-and-environments.md)
(`"dev"` by default, or whatever `--stage` resolved to). You don't declare it:

```ts
app.get("/", (_req, res) => res.json({ stage: process.env.STAGE }));
```

If you also define `STAGE` in `env`, your value wins.

## Per-stage values

Because [`--stage`](./stages-and-environments.md) selects the
environment at deploy time, the common pattern is one pipeline per stage, each
supplying its own values:

- **Shared, non-sensitive defaults** → the `env` map in config.
- **Per-environment values** → declare them with `env()` and provide them from
  each pipeline's environment.

```bash
# dev pipeline
LOG_LEVEL=debug laranja deploy --stage dev
# prod pipeline
LOG_LEVEL=warn  laranja deploy --stage prod
```

## Secrets

`env()` keeps values out of your repo, but they still land in the Lambda's plain
environment — readable by anyone with access to the function's configuration. For
true secrets (API keys, DB passwords), that's not enough. First-class secrets
support is on the roadmap; until then, read them at runtime from a secret store
(e.g. AWS SSM Parameter Store / Secrets Manager) inside your handler.

## Related

- [Config file](../reference/config-file.md)
- [Stages & environments](./stages-and-environments.md)
