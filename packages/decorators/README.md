# @laranja/decorators

Decorators for [laranja](https://github.com/your-org/laranja) — mark scheduled jobs and queue consumers in your Node.js app. laranja scans these statically and provisions the matching AWS infrastructure.

```bash
npm install @laranja/decorators
```

```ts
import { Cron, Queue, rate, every } from "@laranja/decorators";

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
```

- **`@Cron(schedule)`** → EventBridge rule + Lambda. `schedule` is an AWS expression; use `rate(n, unit)` / `every(unit)` or a raw `"cron(...)"`/`"rate(...)"` string. Pass `{ schedule, id }` to set a name.
- **`@Queue({ name, batchSize?, fifo? })`** → SQS queue + consumer Lambda, called once per message with the JSON-parsed body.

📖 **Full docs:** https://github.com/your-org/laranja
