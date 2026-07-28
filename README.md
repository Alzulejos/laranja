# 🍊 laranja

**Code-first deploys for Node.js.** Write your Express or NestJS app and decorate your background jobs — laranja reads your code, figures out the infrastructure, and deploys it to **your own AWS or Azure account**. No YAML, no console clicking, no CDK or ARM to learn.

```bash
$ laranja deploy

🍊 laranja · deploy my-api → eu-central-1
  🔑  account   123456789012
  📦  build     7 routes · 2 crons · 1 queue → 4 λ
  ✓ λ my-api-app-prod
  ✓ λ my-api-refreshCache-prod
  ✓ 📨 emails
  ✅ deployed in 38s

  🌐  http   https://abc123.lambda-url.eu-central-1.on.aws/
  ✨ live
```

> **Status:** early MVP. **Express and NestJS** on **AWS and Azure** are supported today. APIs may change.

## Why laranja?

- **Your code is the source of truth.** Routes and decorators _are_ the infra spec — no drift between app and config.
- **Your account, your data.** Deploys go straight into your own cloud account with your own local credentials. laranja hosts none of your infrastructure.
- **Your source stays local.** laranja _reads_ your code to discover infra — it never runs it, and only a description of your infra ever crosses the wire.
- **Not locked to one cloud.** The same app code deploys to **AWS** or **Azure** — one `provider` field, not a rewrite.
- **Nothing to learn.** The provider toolchain is embedded; there's no CDK, CLI, or Bicep to install. Outgrow the magic? `laranja eject` hands you a fully-owned infrastructure project.

## Install

```bash
npm install @alzulejos/laranja-decorators     # used in your app code
npm install -D @alzulejos/laranja             # the `laranja` command
```

You'll also need **Node.js 22+**, credentials for your cloud on its standard chain (**AWS**: `aws configure`, SSO, or `AWS_*` env vars · **Azure**: `az login` or `AZURE_*`), and a **laranja API key** from the [dashboard](https://laranja.io) — `laranja init` wires it up and asks which cloud to target.

## Express

Mark your app with `http()` and decorate any background jobs. That's the whole surface.

```ts
// src/app.ts
import express from "express";
import { http } from "@alzulejos/laranja-decorators";

const app = express();
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/users/:id", (req, res) => res.json({ id: req.params.id }));

export default http(app); // ← the marker laranja looks for
```

```ts
// src/jobs.ts
import { cron, rate } from "@alzulejos/laranja-decorators";

export async function refreshCache() {
  console.log("refreshing…");
  return true;
}
cron({ schedule: rate(5, "minutes") }, refreshCache);
```

```bash
laranja init      # link a dashboard project + scaffold laranja.config.ts
laranja deploy    # → live HTTPS URL + the scheduled job
```

## NestJS

Same markers — wrap your bootstrap so it `return`s the app, and decorate a queue consumer.

```ts
// src/main.ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { http } from "@alzulejos/laranja-decorators";

export async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3001);
  return app;
}

export default http(bootstrap);
```

```ts
// src/event/event.module.ts
import { Module } from "@nestjs/common";
import { QueueService } from "./queue.service";
import { workers } from "@alzulejos/laranja-decorators";
import { ConfigModule } from "@nestjs/config";
import { UserModule } from "src/user/user.module";

@Module({
  imports: [ConfigModule, UserModule, MailerModule],
  providers: [QueueService],
})
export class EventModule {}

export default workers(EventModule);
```

```ts
// src/event/queue.service.ts
import { Queue } from "@alzulejos/laranja-decorators";
import { Injectable } from "@nestjs/common";

@Injectable()
export class QueueService {
  constructor(private readonly mailer: Mailer) {} // real DI

  @Queue({ name: "emails", batchSize: 10 })
  async sendEmails(body: EmailJob) {
    await this.mailer.send(body);
  }
}
```

Deploys as one function behind a public HTTPS URL, plus a queue with a consumer — a Lambda + Function URL + SQS on AWS, a Function App + Storage Queue on Azure. Produce messages with `getQueue("emails").send(...)`.

## Azure

Same app code, same commands — switch clouds with one config field:

```ts
// laranja.config.ts
const config: LaranjaConfig = {
  name: "my-api",
  projectId: "proj_…",
  provider: "azure",
  region: "westus2",
  azure: { subscriptionId: "…", resourceGroup: "my-existing-group" },
};
```

HTTP, crons, queues, and env vars all work on both. FIFO queues are AWS-only. See the [Azure guide](https://laranja.io/docs/guides/deploying-to-azure).

## Documentation

The README is a taste. Everything else — full decorator API, every config field, all CLI flags, env vars, stages, the AWS/Azure differences, and how the client/server split keeps your source local — lives in the official docs at **[laranja.io/docs](https://laranja.io/docs)**:

- [Introduction & how it works](https://laranja.io/docs/getting-started/how-it-works)
- [Quickstart](https://laranja.io/docs/getting-started/quickstart)
- [Decorators & markers](https://laranja.io/docs/reference/decorators-and-markers)
- [CLI commands](https://laranja.io/docs/reference/commands)
- [Config file](https://laranja.io/docs/reference/config-file)
- [What gets deployed](https://laranja.io/docs/reference/what-gets-deployed)
- [Deploying to Azure](https://laranja.io/docs/guides/deploying-to-azure)

The docs are authored in this repo under [`packages/docs/content/`](packages/docs/content/) — that's the single source, rendered by the site.

## Local development (monorepo)

```bash
npm install
npm run build       # tsc -b across all packages + build the docs
npm run typecheck   # type-check everything
npm run test        # run the vitest suite
```

Run the CLI against an example without publishing (uses `tsx`, resolving to source):

```bash
tsx packages/cli/src/cli.ts plan examples/expressjs
tsx packages/cli/src/cli.ts plan examples/nestjs
```

## License

The laranja client packages in this repository (the CLI, decorators, and supporting
libraries you install to build and deploy your app) are licensed under the
[Apache License 2.0](LICENSE). The hosted laranja backend service is proprietary and
is not part of this repository.
