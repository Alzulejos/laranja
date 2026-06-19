---
title: Config file
description: Every field in laranja.config.ts, with defaults and behavior.
order: 1
---

# `laranja.config.ts`

Every project has a `laranja.config.ts` at its root that `export default`s a
config object. It's a TypeScript module (loaded via `tsx`), so you get full type
checking and can compute values if you need to.

```ts
import type { LaranjaConfig } from "@laranja/core";

const config: LaranjaConfig = {
  name: "my-api",
  region: "us-east-1",
  env: { LOG_LEVEL: "info" },
};

export default config;
```

The config stays minimal because the HTTP app is declared in code with the
[`http()`](../reference/decorators-and-markers.md#http) marker. Run
[`laranja init`](../cli/commands.md#init) to scaffold this file.

## Fields

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | ✅ | — | App name. Used for the CloudFormation stack and all resource names. |
| `entry` | | — | Project-relative module that exports your HTTP app — an **alternative** to the [`http()`](../reference/decorators-and-markers.md#http) marker. Omit it when you use the marker, or for a [workers-only](../guides/http-apps.md#workers-only-deployments) deploy. |
| `appExport` | | `"app"` | The named export of your app within `entry` (only when using `entry`). |
| `region` | | `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS region to deploy to. |
| `stage` | | `"dev"` | Deployment stage. Part of the stack + resource names and injected as the `STAGE` env var. Override per-run with [`--stage`](../concepts/stages-and-environments.md). |
| `profile` | | — | AWS named profile to deploy with. |
| `framework` | | _auto-detected_ | Override framework detection (e.g. `"express"`). |
| `http` | | _enabled_ | Set to `false` for a [workers-only](../guides/http-apps.md#workers-only-deployments) deploy (no HTTP app). |
| `env` | | `{}` | Plain environment variables injected into every Lambda. See [Environment variables](./environment-variables.md). |
| `projectId` | | — | Project id from the laranja dashboard. Used by server-side synth; not needed for local deploys. |
| `provider` | | `"aws"` | Target cloud. Only `"aws"` is implemented today. |

### `name`

Drives the stack name (`‹name›-‹stage›`) and every resource name
(`‹name›-‹fn›-‹stage›`). Choose something short and stable — renaming it after a
deploy creates a _new_ stack rather than renaming the old one.

### `entry` and `appExport`

The recommended, code-first way to declare your HTTP app is the
[`http()` marker](../reference/decorators-and-markers.md#http) — then you can omit
both of these fields. `entry`/`appExport` exist as an alternative for keeping the
wiring in config instead:

```ts
entry: "src/app.ts",
appExport: "app",   // → import { app } from "src/app.ts"
```

Use `appExport: "default"` for a default export. Use the marker or these
fields — not both.

### `region` and `profile`

`region` falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`. If none is set,
the CLI errors with a clear message. `profile` selects a named profile from your
AWS credentials file; otherwise the default credential chain is used.

### `stage`

The default is `"dev"`. It's part of resource names and is injected into every
Lambda as `process.env.STAGE`. The [`--stage`](../concepts/stages-and-environments.md)
flag overrides it per command — the recommended way to drive multiple
environments from one config.

### `http: false`

Deploys only your workers (`@Cron` / `@Queue`) with no HTTP app — for teams whose
API is hosted elsewhere. When omitted, the HTTP proxy is deployed and `entry`
(or an `http()` marker) is required. See
[workers-only deployments](../guides/http-apps.md#workers-only-deployments).

## Related

- [Environment variables](./environment-variables.md)
- [Stages & environments](../concepts/stages-and-environments.md)
