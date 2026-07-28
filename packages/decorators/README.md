# @alzulejos/laranja-decorators

Decorators and markers for [laranja](https://laranja.io) — mark your HTTP app,
scheduled jobs, and queue consumers in your Node.js app. laranja scans these
statically and provisions the matching infrastructure in **your own AWS or Azure
account**. The same markers work on both.

```bash
npm install @alzulejos/laranja-decorators
```

```ts
import { http, Cron, Queue, getQueue, rate, every } from "@alzulejos/laranja-decorators";

export default http(app);   // mark your Express/NestJS app

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() {}

  @Cron(every("day"))
  async nightlyCleanup() {}

  @Cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" })
  async dailyReport() {}

  @Queue({ name: "emails", batchSize: 10 })
  async sendEmails(body: unknown) {}
}

await getQueue("emails").send({ to, template: "welcome" });   // produce
```

| Marker | AWS | Azure |
|---|---|---|
| `http(app)` | Proxy Lambda + Function URL | HTTP function in a Function App |
| `@Cron(schedule)` | Lambda + EventBridge rule | Timer-triggered function |
| `@Queue({ name })` | SQS queue + consumer Lambda | Storage Queue + queue-triggered function |

- **`http(app)`** — one function serving all your routes. The sole way to declare
  your HTTP app; exactly one per project.
- **`@Cron(schedule)`** — use the portable `rate(n, unit)` / `every(unit)`
  builders, a raw `"cron(...)"`/`"rate(...)"` string, or a `@nestjs/schedule`-style
  node-cron expression. Pass `{ schedule, id }` to set a name.
- **`@Queue({ name, batchSize?, fifo? })`** — called once per message with the
  JSON-parsed body. `fifo` is AWS-only.
- Also here: `cron()` / `queue()` function markers, `workers()` for NestJS DI
  roots, `getQueue()` to produce, and `env()` for code-discovered env vars.

This README is a summary — the full API, every option, and the AWS/Azure
differences are documented in the official docs.

📖 **Full docs:** https://laranja.io/docs
