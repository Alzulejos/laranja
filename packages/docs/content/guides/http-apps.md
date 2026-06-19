---
title: HTTP apps
description: Deploy your HTTP app behind a public HTTPS endpoint.
order: 1
---

# HTTP apps

laranja deploys your whole HTTP app as a single proxy Lambda behind a public
[Function URL](../concepts/what-gets-deployed.md#http-app--proxy-lambda--function-url).
laranja supports **Express** today; **NestJS support is coming**.

## Declaring your app (the `http()` marker)

The code-first way: mark your app with the
[`http()`](../reference/decorators-and-markers.md#http) marker and export it.
laranja finds it by scanning your code — there's nothing to configure.

```ts
// src/app.ts
import express from "express";
import { http } from "@laranja/decorators";

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.json({ ok: true }));
app.post("/users", (req, res) => res.status(201).json(req.body));

export default http(app);          // or: export const api = http(app);
```

`http()` returns the app untouched — it's a static marker, not a wrapper, so it
has no runtime effect. That's all you need: every route you register is served by
the deployed proxy.

## Alternative: point at it from config

Prefer to keep it out of your app code? Export the app plainly and name it in
config with `entry` + `appExport` instead of the marker — use one or the other,
not both:

```ts
// src/app.ts
export const app = express();
```

```ts
// laranja.config.ts
const config: LaranjaConfig = {
  name: "my-api",
  entry: "src/app.ts",
  appExport: "app",   // default; use "default" for `export default app`
};
```

## Routing, middleware, and `STAGE`

Your app runs as-is inside Lambda. Standard Express features work — routing,
middleware, JSON bodies, route params. The active
[stage](../concepts/stages-and-environments.md) is available as
`process.env.STAGE`:

```ts
app.get("/whoami", (_req, res) => res.json({ stage: process.env.STAGE }));
```

## CORS and auth

The Function URL is public with permissive CORS (all origins/methods/headers).
Handle authentication and any stricter CORS rules **inside your app**, the same
way you would anywhere else.

## Timeouts

The HTTP proxy Lambda has a **30-second** timeout. Long-running work belongs in a
[cron job](./cron-jobs.md) or behind a [queue](./queues.md), not a request.

## Workers-only deployments

If your HTTP API is hosted elsewhere and you only want to deploy scheduled jobs
and queue consumers, set `http: false` and omit `entry`:

```ts
// laranja.config.ts
const config: LaranjaConfig = {
  name: "my-workers",
  http: false,
  env: { LOG_LEVEL: "info" },
};
```

Now only your [`@Cron`](./cron-jobs.md) / [`@Queue`](./queues.md) handlers are
deployed — no HTTP proxy, no Function URL.

## Related

- [What gets deployed](../concepts/what-gets-deployed.md)
- [Cron jobs](./cron-jobs.md) · [Queues](./queues.md)
