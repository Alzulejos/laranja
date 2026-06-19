---
title: Quickstart
description: From an empty folder to a live HTTPS endpoint in a few minutes.
order: 2
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

> laranja supports **Express** today. **NestJS support is coming.**

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

**Function style** — plain exported functions:

```ts
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

**Class style** — methods with decorators:

```ts
// src/jobs.ts
import { Cron, Queue, rate } from "@laranja/decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() {}

  @Queue({ name: "emails", batchSize: 10 })
  async sendEmail(body: unknown) {}
}
```

## 3. Configure

Run the scaffolder, or create the file by hand:

```bash
npx laranja init
```

```ts
// laranja.config.ts
import type { LaranjaConfig } from "@laranja/core";

const config: LaranjaConfig = {
  name: "my-api",
  region: "us-east-1",
  env: { LOG_LEVEL: "info" },
};

export default config;
```

Because the app is marked with `http()` in code, the config stays minimal — no
`entry` to point at. (Prefer config instead? Set `entry`/`appExport` — see the
**[config reference](../configuration/config-file.md)**.)

## 4. Preview the plan (no AWS calls)

```bash
npx laranja synth
```

```
Plan for "my-api-dev":
  HTTP:    2 route(s) → 1 proxy Lambda + Function URL
  Cron:    1 job(s) → Lambda + EventBridge rule each
  Queues:  1 → SQS + consumer Lambda each
```

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
npx laranja diff            # see what a deploy would change
npx laranja deploy          # ship again
npx laranja destroy         # tear it all down
```

## Next steps

- Ship to multiple environments: **[Stages & environments](../concepts/stages-and-environments.md)**.
- Understand what was created: **[What gets deployed](../concepts/what-gets-deployed.md)**.
- Go deeper on jobs and queues: **[Cron jobs](../guides/cron-jobs.md)**, **[Queues](../guides/queues.md)**.
