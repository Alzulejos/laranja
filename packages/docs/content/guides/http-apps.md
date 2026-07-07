---
title: HTTP apps
description: Deploy your HTTP app behind a public HTTPS endpoint.
order: 1
---

# HTTP apps

laranja deploys your whole HTTP app as a single proxy Lambda behind a public
[Function URL](../reference/what-gets-deployed.md#http-app--proxy-lambda--function-url).
laranja supports **Express** and **NestJS**.

## Declaring your app (the `http()` marker)

The code-first way: mark your app with the
[`http()`](../reference/decorators-and-markers.md#http) marker and export it.
laranja finds it by scanning your code — there's nothing to configure.

```ts
// src/app.ts
import express from "express";
import { http } from "@alzulejos/laranja-decorators";

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

## NestJS

Nest apps work the same way, with one difference: a Nest app only exists after an
async `NestFactory.create(...)`, so instead of a ready app object you wrap your
**bootstrap function** and have it `return` the app:

```ts
// src/main.ts
import { NestFactory } from "@nestjs/core";
import { http } from "@alzulejos/laranja-decorators";
import { AppModule } from "./app.module";

export async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // configure however you like — pipes, guards, middleware, raw body, cookies…
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.listen(process.env.PORT ?? 3000);  // fine to keep for local dev
  return app;                                  // ← the only change laranja needs
}

// Run locally with `npm run start`; skipped when laranja imports this file.
if (require.main === module) void bootstrap();

export default http(bootstrap);   // wrap the factory, not a module
```

laranja runs your `bootstrap()` verbatim, so every pipe, guard, and piece of
middleware you configure is preserved — nothing is re-derived. You keep your
normal Nest project (`@nestjs/platform-express`); no laranja-specific
restructuring.

Two things to know:

- **Build before you deploy.** laranja packages your compiled output (`nest build`
  → `dist/`), because Nest's dependency injection relies on the decorator
  metadata your own TypeScript build emits. Run your build first (a stale/missing
  `dist/` fails the deploy with a clear message).
- **Use the default Express platform.** The Fastify adapter isn't supported yet.

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

For a **workers-only Nest** app, there's no `http(bootstrap)` to build the DI
container from, so declare your module with the
[`workers()`](../reference/decorators-and-markers.md#workers) marker instead
(`export default workers(AppModule)`) — see [Cron jobs → NestJS](./cron-jobs.md#nestjs).

## Related

- [What gets deployed](../reference/what-gets-deployed.md)
- [Cron jobs](./cron-jobs.md) · [Queues](./queues.md)
