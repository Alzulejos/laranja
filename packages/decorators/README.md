# @alzulejos/laranja-decorators

Decorators and markers for [laranja](https://laranja.io) — mark your HTTP app, scheduled jobs, and queue consumers in your Node.js app. laranja scans these statically and provisions the matching AWS infrastructure.

```bash
npm install @alzulejos/laranja-decorators
```

```ts
import { http, Cron, Queue, rate, every } from "@alzulejos/laranja-decorators";

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
```

- **`http(app)`** → one Lambda behind a Function URL serving all your routes. The sole way to declare your HTTP app; exactly one per project.
- **`@Cron(schedule)`** → EventBridge rule + Lambda. `schedule` is an AWS expression; use `rate(n, unit)` / `every(unit)` or a raw `"cron(...)"`/`"rate(...)"` string. Pass `{ schedule, id }` to set a name.
- **`@Queue({ name, batchSize?, fifo? })`** → SQS queue + consumer Lambda, called once per message with the JSON-parsed body.

📖 **Full docs:** https://laranja.io/docs
