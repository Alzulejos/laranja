---
title: Quickstart
description: From an empty folder to a live HTTPS endpoint in a few minutes.
order: 3
---

# Quickstart

This walks you from zero to a deployed app with an HTTP endpoint, a scheduled
job, and a queue consumer.

## 1. Create a project

```bash
mkdir my-api && cd my-api
npm init -y
npm install express
npm install -D @laranja/cli typescript
npm install @laranja/decorators
```

> laranja supports **Express** and **NestJS**. For Nest, see the
> [HTTP apps guide](../guides/http-apps.md#nestjs).

## 2. Write your app

Mark your app with [`http()`](../reference/decorators-and-markers.md#http) and
export it. laranja finds it by reading your code — so there's nothing to wire up
in config:

```ts
// src/app.ts
import express from "express";
import { http } from "@laranja/decorators";

const app = express();
app.get("/", (_req, res) => res.json({ ok: true, stage: process.env.STAGE }));
app.get("/users/:id", (req, res) => res.json({ id: req.params.id }));

export default http(app);
```

Add a scheduled job and a queue consumer (optional). There are two styles — pick
whichever fits your codebase.

```ts tab="Function"
// src/jobs.ts
import { cron, queue, rate } from "@laranja/decorators";

export async function refreshCache() {
  console.log("refreshing cache…");
}
cron(rate(5, "minutes"), refreshCache);

export async function sendEmail(body: unknown) {
  console.log("sending", body);
}
queue({ name: "emails", batchSize: 10 }, sendEmail);
```

```ts tab="Class"
// src/jobs.ts
import { Cron, Queue, rate } from "@laranja/decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() {}

  @Queue({ name: "emails", batchSize: 10 })
  async sendEmail(body: unknown) {}
}
```

## 3. Sign in and configure

Run the scaffolder. It prompts for your **laranja API key** (from the dashboard),
validates it, stores it in `~/.laranja/auth.json`, and lets you pick or create a
**dashboard project** — filling in `name` and `projectId` for you:

```bash
npx laranja init
```

The generated `laranja.config.ts` looks like this (edit `region`, `env`, and
`compute` to taste):

```ts
// laranja.config.ts
import type { LaranjaConfig } from "@laranja/decorators";

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

Because the app is marked with `http()` in code, the config stays minimal — the
HTTP app is declared there, not in config. See the
**[config reference](../reference/config-file.md)**.

## 4. Preview the plan

`plan` shows what a deploy would do: it synthesizes your template on the server,
diffs it against what's deployed in your AWS account, and tags each resource
**created / changed / unchanged**. It's **read-only** — nothing is applied, and it
never counts against your deploy limit.

```bash
npx laranja plan
```

```
Plan for "my-api-dev"

+ http     HTTP   2 routes → proxy Lambda + Function URL
+ daily    Cron   Lambda + EventBridge rule
+ emails   Queue  SQS + consumer Lambda

8 AWS resources  +8 created  =0 unchanged
```

On this first run nothing is deployed yet, so everything shows as `+` created.

## 5. Deploy

```bash
npx laranja deploy
```

The first deploy to a new account/region prompts you to **bootstrap** (a
one-time setup in your account). When it finishes you'll see your live URL:

```
🌐 http   https://abc123.lambda-url.us-east-1.on.aws/
```

Hit it:

```bash
curl https://abc123.lambda-url.us-east-1.on.aws/
# {"ok":true,"stage":"dev"}
```

## 6. Iterate

```bash
npx laranja logs            # tail CloudWatch logs (pick a function)
npx laranja plan            # see what a deploy would change
npx laranja deploy          # ship again
npx laranja destroy         # tear it all down
```

## Next steps

- Ship to multiple environments: **[Stages & environments](../guides/stages-and-environments.md)**.
- Understand what was created: **[What gets deployed](../reference/what-gets-deployed.md)**.
- Go deeper on jobs and queues: **[Cron jobs](../guides/cron-jobs.md)**, **[Queues](../guides/queues.md)**.
