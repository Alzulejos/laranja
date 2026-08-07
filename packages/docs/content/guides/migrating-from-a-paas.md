---
title: Migrating from a PaaS
seoTitle: Migrate an Express or NestJS app from Vercel, Railway, or Render
description: Move an Express or NestJS app off Vercel, Railway, Render, or Heroku into your own AWS or Azure account. What each concept maps to, what changes, and what you delete.
order: 8
---

# Migrating from a PaaS

If your app runs on **Vercel, Railway, Render, Heroku, or Fly**, it runs on
infrastructure those companies own. You hand over a repo; they build it, run it
in their account, and resell you the compute. laranja does the opposite: it
reads the same app and provisions the equivalent resources in **your own AWS or
Azure account**, with your own credentials, from your machine.

The app code barely changes. What changes is where it lives, who owns the bill,
and what you can do with it afterwards.

## What actually differs

| | PaaS (Vercel, Railway, Render, Heroku) | laranja |
|---|---|---|
| Whose account | Theirs | **Yours** — AWS or Azure |
| Credentials | You connect a repo, or grant them access | Your local credentials, never uploaded |
| Cloud bill | Resold through them | Direct from your provider |
| Infrastructure | Opaque — you get logs and a URL | Real, named resources you can see in the console |
| Leaving | Redeploy somewhere else from scratch | [`laranja eject`](../reference/commands.md#eject) hands you plain CDK |
| Scope | Runs your whole repo | Deploys your app, crons, and queues |

The last row is the honest limit, and it's covered in
[what you still own](#what-you-still-own) below.

## The mapping

Most of a migration is recognizing that you already declared these things — just
in their dashboard instead of in your code.

| On your PaaS | In laranja |
|---|---|
| A web service running `node dist/main.js` | The [`http()`](./http-apps.md) marker on your app |
| `PORT` + `app.listen()` | Nothing — laranja serves the app itself |
| Env vars in their dashboard | [`env`](./environment-variables.md) in `laranja.config.ts` |
| Preview / staging / production environments | [`--stage`](./stages-and-environments.md) |
| A cron job add-on, or a scheduler UI | [`@Cron` / `cron()`](./cron-jobs.md) |
| A worker dyno + Redis + BullMQ | [`@Queue` / `queue()`](./queues.md) — the queue is the provider's |
| Their build settings | Your `package.json` build script |
| `Dockerfile`, `Procfile`, `render.yaml`, `railway.toml`, `vercel.json` | Deleted |

### Your HTTP app

Mark the app you already have and export it — see [HTTP apps](./http-apps.md)
for both styles:

```ts
// Express
export default http(app);

// NestJS — wrap the bootstrap factory, and have it return the app
export default http(bootstrap);
```

Keep `listen()` outside the factory, guarded for local dev. laranja serves your
app itself, so a `listen()` on the deployed path binds a port nothing reads.
This is the one code change most migrations need.

### Environment variables

Copy them out of the dashboard into config, and give each stage its own values:

```ts
// laranja.config.ts
const config: LaranjaConfig = {
  name: "my-api",
  projectId: "proj_…",
  env: { LOG_LEVEL: "info" },
};
```

Everything in `env` reaches every deployed function through `process.env`,
exactly as it did before. `STAGE` is injected for you.

### Scheduled jobs

A cron add-on becomes a decorated method — and its own function in your account,
with its own logs:

```ts
@Cron(every("day"))
async nightlyReport() { /* … */ }
```

### Background workers

This is the one that usually pays for the move. A worker dyno plus a managed
Redis plus BullMQ collapses into a decorated method — the queue is an SQS queue
(AWS) or a Storage Queue (Azure), managed by your provider, with **no Redis
instance to run or pay for**:

```ts
@Queue({ name: "emails", batchSize: 10 })
async sendEmail(body: unknown) { /* … */ }
```

Producing is `getQueue("emails").send(...)` from anywhere in your app. Read
[Queues](./queues.md) first: this is delivery, retries, and a dead-letter queue —
not BullMQ's scheduling and workflow features. If you lean on those, keep BullMQ.

## Doing the move

```bash
npm install -D @alzulejos/laranja
npx laranja init          # pick the project; fills in name + projectId
npx laranja plan          # see what would be created, change nothing
npx laranja deploy --stage staging
```

Deploy to a throwaway stage first. Each stage is a fully independent deployment,
so `staging` cannot touch anything, and `npx laranja destroy --stage staging`
removes it completely. Point real traffic over only once that stage answers
correctly, then `deploy --stage prod`.

## What changes at runtime

Your app becomes **request-scoped compute** rather than a process that stays up.
For a normal REST API this is invisible. It matters if you rely on:

- **In-memory state between requests** — a cache, a counter, a session store.
  Move it to a real store; instances are not shared and do not persist.
- **`setInterval` / background timers** started at boot — express these as
  [cron jobs](./cron-jobs.md) instead.
- **Long-lived connections** — WebSockets and SSE need a connection held open,
  which a request-scoped function does not provide.
- **Writing to local disk** — treat the filesystem as ephemeral and use object
  storage.
- **The first request after idle** being slower (a cold start).

If your app is a stateless HTTP API with some jobs and workers, none of this
applies. If it's a WebSocket server, laranja is the wrong tool today.

## What you still own

laranja deploys **your app and its triggers** — functions, public endpoints,
schedules, and queues ([the full list](../reference/what-gets-deployed.md)). It
does not provision databases. The managed Postgres or Redis add-on that came
bundled with your PaaS is the one piece that does not migrate automatically:
point `env` at a database you run (RDS, Azure Database, Neon, Supabase, or the
one you already have) before you cut traffic over.

That is a deliberate boundary, not a gap to be filled later. Your data outlives
your deploy tool.

## Related

- [How it works](../getting-started/how-it-works.md) · [Quickstart](../getting-started/quickstart.md)
- [What gets deployed](../reference/what-gets-deployed.md)
- [Stages & environments](./stages-and-environments.md)
- [`laranja eject`](../reference/commands.md#eject) — leave with your infrastructure intact
