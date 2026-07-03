---
title: HTTP apps
description: Deploy your HTTP app behind a public HTTPS endpoint.
order: 1
---

# HTTP apps

laranja deploys your whole HTTP app as a single proxy Lambda behind a public
[Function URL](../reference/what-gets-deployed.md#http-app--proxy-lambda--function-url).
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
the deployed proxy. The marker is the only way to declare an HTTP app — there's
exactly one per project, and it must be exported so the scanner can find it.

## Routing, middleware, and `STAGE`

Your app runs as-is inside Lambda. Standard Express features work — routing,
middleware, JSON bodies, route params. The active
[stage](./stages-and-environments.md) is available as
`process.env.STAGE`:

```ts
app.get("/whoami", (_req, res) => res.json({ stage: process.env.STAGE }));
```

## CORS and auth

The Function URL is public with permissive CORS (all origins/methods/headers).
Handle authentication and any stricter CORS rules **inside your app**, the same
way you would anywhere else.

## Compute (memory & timeout)

The HTTP proxy Lambda's memory and timeout come from
[`compute`](../reference/config-file.md#compute) in your config — the scaffold
default is `{ memory: 256, timeout: 30 }`, and you can override it under the `http`
key in [`resources`](../reference/config-file.md#resources). Long-running work
belongs in a [cron job](./cron-jobs.md) or behind a [queue](./queues.md), not a
request.

## Workers-only deployments

If your HTTP API is hosted elsewhere and you only want to deploy scheduled jobs
and queue consumers, just don't add an `http()` marker — there's nothing to set
in config:

```ts
// laranja.config.ts
const config: LaranjaConfig = {
  name: "my-workers",
  env: { LOG_LEVEL: "info" },
};
```

With no marker, only your [`@Cron`](./cron-jobs.md) / [`@Queue`](./queues.md)
handlers are deployed — no HTTP proxy, no Function URL.

## Related

- [What gets deployed](../reference/what-gets-deployed.md)
- [Cron jobs](./cron-jobs.md) · [Queues](./queues.md)
