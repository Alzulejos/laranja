---
title: Config file
description: Every field in laranja.config.ts, with defaults and behavior.
order: 2
---

# `laranja.config.ts`

Every project has a `laranja.config.ts` at its root that `export default`s a
config object. It's a TypeScript module (loaded via `tsx`), so you get full type
checking and can compute values if you need to.

```ts
import type { LaranjaConfig } from "@alzulejos/laranja-decorators";

const config: LaranjaConfig = {
  name: "my-api",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "proj_…",
  region: "us-east-1",
  env: { LOG_LEVEL: "info" },
  // Default compute for every function (the HTTP proxy + each cron/queue).
  compute: { memory: 256, timeout: 30 },
};

export default config;
```

The config stays minimal because the HTTP app is declared in code with the
[`http()`](./decorators-and-markers.md#http) marker — there's no config field for
it. For a deploy with no HTTP app, just omit the marker (see
[workers-only deployments](../guides/http-apps.md#workers-only-deployments)). Run
[`laranja init`](./commands.md#init) to scaffold this file — it fills in
`name` and `projectId` from the dashboard project you pick.

## Fields

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | ✅ | — | App name. Used for the CloudFormation stack and all resource names. |
| `region` | | `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS region to deploy to. |
| `stage` | | `"dev"` | Deployment stage. Part of the stack + resource names and injected as the `STAGE` env var. Override per-run with [`--stage`](../guides/stages-and-environments.md). |
| `profile` | | — | AWS named profile to deploy with. |
| `framework` | | _auto-detected_ | Override framework detection (e.g. `"express"`). |
| `env` | | `{}` | Plain environment variables injected into every Lambda. See [Environment variables](../guides/environment-variables.md). |
| `cors` | | _off_ | Cross-origin access for your HTTP app's public endpoint. Off by default (same-origin only). See [cors](#cors). |
| `compute` | | `{ memory: 256, timeout: 30 }` | Default memory (MB) and timeout (s) for **every** function. See [compute](#compute). |
| `resources` | | `{}` | Per-resource overrides keyed by resource id (`http`, or a cron/queue id). See [resources](#resources). |
| `projectId` | ✅ | — | Project id from the laranja dashboard. Required by the server-side build (`plan`/`deploy`/`eject`); `laranja init` fills it in. |
| `provider` | | `"aws"` | Target cloud. Only `"aws"` is implemented today. |

### `name`

Drives the stack name (`‹name›-‹stage›`) and every resource name
(`‹name›-‹fn›-‹stage›`). Choose something short and stable — renaming it after a
deploy creates a _new_ stack rather than renaming the old one.

### `region` and `profile`

`region` falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`. If none is set,
the CLI errors with a clear message. `profile` selects a named profile from your
AWS credentials file; otherwise the default credential chain is used.

### `stage`

The default is `"dev"`. It's part of resource names and is injected into every
Lambda as `process.env.STAGE`. The [`--stage`](../guides/stages-and-environments.md)
flag overrides it per command — the recommended way to drive multiple
environments from one config.

### `cors`

Cross-origin resource sharing for your HTTP app's public endpoint. **Off by
default** — with no `cors` set, browsers only allow same-origin requests (calls
from your server, `curl`, or mobile apps are unaffected either way). Opt in by
listing what you want to allow:

```ts
const config: LaranjaConfig = {
  name: "my-api",
  projectId: "proj_…",
  cors: {
    allowOrigins: ["https://app.example.com"],
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type", "Authorization"],
  },
};
```

| Key | Description |
|---|---|
| `allowOrigins` | Origins allowed to call the endpoint, e.g. `["https://app.example.com"]` or `["*"]`. |
| `allowMethods` | HTTP methods allowed, e.g. `["GET", "POST"]` or `["*"]`. |
| `allowHeaders` | Request headers a browser may send. |
| `exposeHeaders` | Response headers exposed to the browser beyond the CORS-safelisted defaults. |
| `allowCredentials` | Allow cookies / `Authorization` on cross-origin requests. Can't be combined with a wildcard `allowOrigins: ["*"]`. |
| `maxAge` | Seconds a browser may cache the preflight (`OPTIONS`) response. |

The fields are provider-neutral — on AWS they configure the HTTP app's Lambda
Function URL CORS. `cors` has no effect on a
[workers-only deployment](#workers-only-deployments) (there's no public endpoint
to open), and setting it there is a hard error rather than a silent no-op.

### `compute`

The default **memory** (MB) and **timeout** (seconds) applied to every function —
the HTTP proxy and each cron/queue consumer. The scaffold sets
`{ memory: 256, timeout: 30 }`:

```ts
const config: LaranjaConfig = {
  name: "my-api",
  projectId: "proj_…",
  compute: { memory: 512, timeout: 20 },
};
```

### `resources`

Per-resource overrides, keyed by **resource id** — `http` for the proxy, or the
[`id`](./decorators-and-markers.md#cron) of a cron/queue. Each entry
merges field-by-field on top of `compute`, and queue/cron entries also accept
their kind-specific knobs (e.g. a queue's `visibilityTimeout`). An unknown id is
a hard error, so a typo can't silently no-op:

```ts
const config: LaranjaConfig = {
  name: "my-api",
  projectId: "proj_…",
  compute: { memory: 256, timeout: 30 },
  resources: {
    http: { memory: 512 },               // beefier proxy
    cleanup: { timeout: 60 },            // a slow cron by its id
    emails: { visibilityTimeout: 180 },  // a queue by its name/id
  },
};
```

### Workers-only deployments

To deploy only your workers (`@Cron` / `@Queue`) with no HTTP app — for teams
whose API is hosted elsewhere — simply don't add an `http()` marker. No flag is
needed. See [workers-only deployments](../guides/http-apps.md#workers-only-deployments).

## Related

- [Environment variables](../guides/environment-variables.md)
- [Stages & environments](../guides/stages-and-environments.md)
