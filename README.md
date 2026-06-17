# 🍊 laranja

**Code-first deploys for Node.js.** Write your Express app and decorate your background jobs — laranja scans your code, figures out the infrastructure, and deploys it to **your own AWS account**. No YAML, no console clicking, no CDK to learn.

```ts
@Cron(rate(5, "minutes"))
async refreshCache() { /* ... */ }

@Queue({ name: "emails", batchSize: 10 })
async sendEmails(body: EmailJob) { /* ... */ }
```

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

> **Status:** early MVP. Express is supported today; NestJS is on the roadmap. APIs may change.

---

## Why laranja?

- **Code is the source of truth.** Your decorators *are* the infra spec — no drift between app and config.
- **Static, safe analysis.** laranja reads your code with the TypeScript compiler; it never executes it to discover routes/jobs.
- **Your account, your data.** Deploys go straight into your AWS account using your own credentials. laranja hosts nothing.
- **No CDK/CLI to install.** The AWS CDK toolkit is embedded — you don't install or learn it.
- **Eject anytime.** Outgrow the magic? Generate a fully-owned CDK project you control.

## What gets deployed

| You write | laranja creates |
|---|---|
| An Express `app` | One **Lambda** behind a **Function URL** (HTTPS), serving all routes |
| `@Cron(...)` method | A **Lambda** + an **EventBridge** schedule rule |
| `@Queue({...})` method | An **SQS queue** + a consumer **Lambda** (with partial-batch failure reporting) |

All bundled with esbuild, scaled to zero, pay-per-use. No API Gateway, no servers.

---

## Install

```bash
npm install @laranja/decorators        # used in your app code
npm install -D @laranja/cli            # the `laranja` command
```

You'll also need:

- **Node.js 20+**
- **AWS credentials** on the standard chain (`aws configure`, SSO, or `AWS_*` env vars) — the AWS CLI itself is *not* required.

## Quick start

**1. Your app** — export the Express app (`src/app.ts`):

```ts
import express from "express";

export const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.json({ ok: true, stage: process.env.STAGE }));
app.get("/users/:id", (req, res) => res.json({ id: req.params.id }));
```

**2. Your jobs** — decorate methods (`src/jobs.ts`):

```ts
import { Cron, Queue, rate, every } from "@laranja/decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() {
    console.log("refreshing…");
  }

  @Cron(every("day"))
  async nightlyCleanup() {}

  @Cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" })
  async dailyReport() {}

  @Queue({ name: "emails", batchSize: 10 })
  async sendEmails(body: unknown) {
    console.log("got message", body);
  }
}
```

**3. Configure** — `laranja.config.ts` (or run `laranja init`):

```ts
import type { LaranjaConfig } from "@laranja/core";

const config: LaranjaConfig = {
  name: "my-api",
  region: "eu-central-1",
  stage: "prod",
  entry: "src/app.ts",   // module that exports your app
  appExport: "app",      // the export name
  env: { LOG_LEVEL: "info" },
};

export default config;
```

**4. Deploy:**

```bash
npx laranja deploy        # first run prompts to bootstrap your account
```

That's it. You'll get a live HTTPS URL, scheduled jobs, and queues.

---

## Decorators

### `@Cron` — scheduled jobs

Schedules are **AWS EventBridge** expressions. Use the typed builders, or pass a raw string.

```ts
@Cron(rate(5, "minutes"))                              // rate(5 minutes)
@Cron(every("day"))                                    // rate(1 day)
@Cron({ schedule: "cron(0 12 * * ? *)", id: "report" })// raw cron + a custom name
```

- `rate(value, unit)` → `"minute(s)" | "hour(s)" | "day(s)"`
- `every(unit)` → shorthand for `rate(1, unit)`
- `id` (optional) sets the function name; otherwise the method name is used.

### `@Queue` — SQS consumers

```ts
@Queue({ name: "emails", batchSize: 10 })
async sendEmails(body: unknown, record, context) { /* ... */ }

@Queue({ name: "orders.fifo", fifo: true })   // .fifo suffix → FIFO queue
async processOrders(body: unknown) { /* ... */ }
```

The consumer is called **once per message** with the JSON-parsed `body`. Throwing marks just that message as failed (the rest of the batch still succeeds), via SQS partial-batch responses.

---

## Commands

```bash
laranja init       # scaffold laranja.config.ts
laranja synth      # build & print the planned resources (no AWS calls)
laranja deploy     # deploy into your AWS account
laranja diff       # diff the plan against what's deployed
laranja destroy    # tear it all down
laranja logs       # tail CloudWatch logs for a deployed function
laranja eject      # generate an owned CDK project (Pro)

# flags
  --verbose, -v    # stream full CDK/CloudFormation output
  --all            # logs: tail every function (multiplexed)
  --no-follow      # logs: print recent history and exit
  --since <dur>    # logs: history look-back, e.g. 30s, 15m, 1h, 2d
```

Each command takes an optional `[project-dir]` (defaults to the current directory).

## Configuration

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | ✅ | — | App name; used for the stack and resource names |
| `entry` | ✅ | — | Project-relative module exporting your app |
| `region` | | `AWS_REGION` | AWS region to deploy to |
| `stage` | | `"dev"` | Stage; part of resource names, also injected as `STAGE` env |
| `appExport` | | `"app"` | Named export of the app within `entry` |
| `profile` | | — | AWS named profile to deploy with |
| `env` | | `{}` | Plain env vars injected into every Lambda |

**Resource naming:** Lambdas are named `‹name›-‹fn›-‹stage›` (e.g. `my-api-app-prod`, `my-api-sendEmails-prod`) — deterministic, no random suffixes.

---

## How it works

```
your code ──▶ scan (ts-morph) ──▶ Infra IR ──▶ bundle (esbuild) ──▶ CDK ──▶ your AWS account
            decorators + routes    (JSON)        per-λ assets      toolkit-lib
```

1. **Scan** — the TypeScript AST is read to find your app, routes, `@Cron`, and `@Queue` (no code execution).
2. **IR** — a small JSON description of your infrastructure (the stable boundary).
3. **Bundle** — each handler is bundled into its own tiny Lambda artifact.
4. **Deploy** — an embedded CDK toolkit synthesizes and deploys to CloudFormation in your account.

## Custom domains

laranja exposes your app via a **Lambda Function URL** (stable across deploys). To put your own domain on it, point a **CloudFront** distribution (with an ACM cert) at the Function URL and add a Route 53 record. Automated custom-domain support is on the roadmap.

## Pro: `laranja eject`

Want full control? `laranja eject` writes a standalone, **fully-owned CDK project** into `infra/` — readable constructs, self-bundling, deployable with plain `cdk deploy`. No laranja required afterward.

```bash
laranja eject
cd infra && npm install && npm run deploy
```

## Roadmap

- [x] `laranja logs` — tail CloudWatch with the same clean UI
- [ ] NestJS support (native `@Controller`/`@Get` discovery + DI)
- [ ] Automated custom domains (CloudFront + ACM + Route 53)
- [ ] Hosted dashboard (read-only, via a role you grant)
- [ ] Secrets & resource decorators (`@Secret`, `@Table`)

## Local development (monorepo)

```bash
npm install
npm run scan:express      # see the Infra IR for the example
npm run synth:express     # see the planned resources
npm run deploy:express    # deploy the example (needs AWS creds)
npm run destroy:express
```

## License

TBD — laranja is in early development.
