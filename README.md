# 🍊 laranja

**Code-first deploys for Node.js.** Write your Express or NestJS app and decorate your background jobs — laranja reads your code, figures out the infrastructure, and deploys it to **your own AWS account**. No YAML, no console clicking, no CDK to learn.

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

> **Status:** early MVP. **Express and NestJS** are supported today. APIs may change.

---

## Why laranja?

- **Code is the source of truth.** Your routes and decorators *are* the infra spec — no drift between app and config.
- **Safe by default.** laranja reads your code to discover infra — it never runs it. Your source never leaves your machine; only a description of your infrastructure does.
- **Your account, your data.** Deploys go straight into your AWS account using your own local credentials. laranja hosts none of your infrastructure.
- **No CDK/CLI to install.** The AWS CDK toolkit is embedded — you don't install or learn it.
- **Eject anytime.** Outgrow the magic? Generate a fully-owned CDK project you control.

## What gets deployed

| You write | laranja creates |
|---|---|
| An HTTP app marked with `http(...)` (Express or NestJS) | One **Lambda** behind a **Function URL** (HTTPS), serving all routes |
| `@Cron(...)` / `cron(...)` | A **Lambda** + an **EventBridge** schedule rule |
| `@Queue({...})` / `queue(...)` | An **SQS queue** + a consumer **Lambda** (with partial-batch failure reporting) |

All bundled with esbuild, scaled to zero, pay-per-use. No API Gateway, no servers.

---

## How it works

laranja splits the work between your machine and the laranja server, so your code stays local:

1. **Your machine scans your code.** laranja reads your app, routes, `@Cron`/`@Queue` jobs, and the env vars you wrap with `env()` — statically, never executing it — and produces a framework-neutral description of your infrastructure.
2. **The laranja server synthesizes the template** from that description (this is what gates paid features and keeps the CDK logic server-side). Only the infra description crosses the wire — **your source code never does.**
3. **Your machine deploys it** into your AWS account using your own local AWS credentials.

Because of step 2, commands that build a template (`plan`, `deploy`, `eject`) need a **laranja API key** and a `projectId` — you get both from the dashboard and wire them up once with `laranja init`.

---

## Install

```bash
npm install @laranja/decorators        # used in your app code
npm install -D @laranja/cli            # the `laranja` command
```

You'll also need:

- **Node.js 20+**
- **A laranja account + API key** — laranja synthesizes your template on its server, so `plan`/`deploy`/`eject` need a key. Get one from the dashboard; `laranja init` stores it in `~/.laranja/auth.json`.
- **AWS credentials** on the standard chain (`aws configure`, SSO, or `AWS_*` env vars) — the AWS CLI itself is *not* required.

## Quick start

**1. Your app** — mark your HTTP app with `http()` and export it (`src/app.ts`):

```ts
import express from "express";
import { http } from "@laranja/decorators";

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.json({ ok: true, stage: process.env.STAGE }));
app.get("/users/:id", (req, res) => res.json({ id: req.params.id }));

export default http(app);   // or: export const api = http(app);
```

NestJS works the same way — wrap your bootstrap function so it `return`s the app:

```ts
// src/main.ts
export async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  return http(app);   // ← the only change laranja needs
}
```

**2. Your jobs** — decorate methods, or use the function form (`src/jobs.ts`):

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

> For NestJS crons/queues that use dependency injection, declare the module laranja
> resolves them against with the [`workers()`](#markers) marker.

**3. Link the project** — run `laranja init`:

```bash
laranja init
```

`init` prompts for your API key, lets you pick or create a dashboard project, and scaffolds `laranja.config.ts` with `name` and `projectId` filled in:

```ts
import type { LaranjaConfig } from "@laranja/decorators";

const config: LaranjaConfig = {
  name: "my-api",
  projectId: "…",           // from your laranja dashboard
  region: "eu-central-1",
  stage: "prod",
  env: { LOG_LEVEL: "info" },
  compute: { memory: 256, timeout: 30 },
};

export default config;
```

**4. Deploy:**

```bash
npx laranja deploy        # first run prompts to bootstrap your account
```

That's it. You'll get a live HTTPS URL, scheduled jobs, and queues.

---

## Environment variables

Put commit-safe config in the `env` map. For values that should come from your
shell or CI, wrap them with `env()` — laranja finds them and populates every
function at deploy time, so you never fill them in by hand in the console:

```ts
import { env } from "@laranja/decorators";

const dbUrl = env("DATABASE_URL"); // process.env.DATABASE_URL at runtime
```

```bash
DATABASE_URL=postgres://… laranja deploy --stage prod
```

The name must be a string literal. Only the **name** crosses the wire to the
server; the **value** is resolved on your machine at deploy time and never leaves
it. Missing a value? laranja deploys and warns (use `--strict` to fail instead).
See the [env vars guide](packages/docs/content/guides/environment-variables.md) for details.

---

## Decorators & markers

### `http()` — mark your HTTP app

The sole, code-first way to declare your HTTP app. Returns the app untouched (a
static marker, no runtime effect); the scanner finds it by its export. Exactly one
per project. Omit it entirely for a workers-only deployment.

```ts
export default http(app);       // Express: the app object
return http(app);               // NestJS: from your bootstrap function
```

### `@Cron` / `cron()` — scheduled jobs

Schedules are **AWS EventBridge** expressions. Use the typed builders, a raw
string, or (for Nest) a `@nestjs/schedule`-style expression.

```ts
@Cron(rate(5, "minutes"))                               // rate(5 minutes)
@Cron(every("day"))                                     // rate(1 day)
@Cron({ schedule: "cron(0 12 * * ? *)", id: "report" }) // raw cron + a custom name
@Cron("0 3 * * *", { name: "nightly" })                 // @nestjs/schedule form
@Cron(CronExpression.EVERY_30_MINUTES)                  // @nestjs/schedule enum
```

- `rate(value, unit)` → `"minute(s)" | "hour(s)" | "day(s)"`; `every(unit)` = `rate(1, unit)`.
- `id` (optional) sets the function name; otherwise `‹Class›-‹method›` is used.
- `@Interval(ms)` is supported (lowered to a `rate`); `@Timeout` is rejected — a one-shot timer has no serverless equivalent.
- No classes? Use the function form: `cron(rate(5, "minutes"), refreshCache)`.

### `@Queue` / `queue()` — SQS consumers

```ts
@Queue({ name: "emails", batchSize: 10 })
async sendEmails(body: unknown) { /* ... */ }

@Queue({ name: "orders.fifo", fifo: true })   // .fifo suffix → FIFO queue
async processOrders(body: unknown) { /* ... */ }
```

The consumer is called **once per message** with the JSON-parsed `body`. Throwing
marks just that message as failed (the rest of the batch still succeeds), via SQS
partial-batch responses. To **produce** messages, use `getQueue("emails").send(...)`.

### `workers()` — DI root for Nest jobs

Declare the Nest module laranja resolves background workers against, so each worker
Lambda resolves its provider (and its injected dependencies) through real DI:

```ts
export default workers(AppModule);
```

---

## Commands

```bash
laranja init       # sign in + scaffold laranja.config.ts, link a dashboard project
laranja plan       # preview: server-synth the template, diff against the live stack
laranja deploy     # deploy into your AWS account
laranja destroy    # tear it all down
laranja logs       # tail CloudWatch logs for a deployed function
laranja eject      # generate an owned CDK project (paid)
laranja logout     # remove the stored API key

# flags
  --stage, -s <name>  # target a stage (dev/staging/prod); overrides config
  --verbose, -v       # deploy: stream full CDK/CloudFormation output
  --strict            # deploy: fail if any env() value is unset (default: warn)
  --force             # eject: overwrite an existing ./infra
  --all               # logs: tail every function (multiplexed)
  --no-follow         # logs: print recent history and exit
  --since <dur>       # logs: history look-back, e.g. 30s, 15m, 1h, 2d
```

Each command takes an optional `[project-dir]` (defaults to the current directory).
See the full [CLI reference](packages/docs/content/reference/commands.md).

### Stages

`--stage` (alias `-s`) overrides `config.stage` and applies to `deploy`, `plan`,
`destroy`, `logs`, and `eject`. Each stage is its own CloudFormation stack named
`‹name›-‹stage›`, so one repo drives a pipeline per environment:

```bash
laranja deploy --stage dev
laranja deploy --stage staging
laranja deploy --stage prod
```

Stages can live in one AWS account (distinct stacks) or in separate accounts
(your AWS credentials are the boundary) — either way the stacks never collide.

## Configuration

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | ✅ | — | App name; used for the stack and resource names |
| `projectId` | ✅ | — | Project id from your laranja dashboard; identifies the project to the server (`laranja init` fills it in) |
| `region` | | `AWS_REGION` | AWS region to deploy to |
| `stage` | | `"dev"` | Stage; part of the stack + resource names, also injected as `STAGE` env. Override per-run with `--stage` |
| `profile` | | — | AWS named profile to deploy with |
| `framework` | | *auto-detected* | Override framework detection (`"express"` / `"nestjs"`) |
| `env` | | `{}` | Plain env vars injected into every Lambda |
| `compute` | | `{ memory: 256, timeout: 30 }` | Default memory/timeout for **every** function |
| `resources` | | `{}` | Per-resource overrides keyed by id (`http`, or a cron/queue id) |
| `monitoring` | | `true` | Emit a per-stage CloudWatch dashboard with per-function metrics |
| `provider` | | `"aws"` | Target cloud. Only `"aws"` is implemented today |

**Resource naming:** the stack is `‹name›-‹stage›` (e.g. `my-api-prod`) and Lambdas are `‹name›-‹fn›-‹stage›` (e.g. `my-api-app-prod`, `my-api-sendEmails-prod`) — deterministic, no random suffixes.

---

## Custom domains

laranja exposes your app via a **Lambda Function URL** (stable across deploys). To put your own domain on it, point a **CloudFront** distribution (with an ACM cert) at the Function URL and add a Route 53 record. Automated custom-domain support is on the roadmap.

## Paid: `laranja eject`

Want full control? `laranja eject` generates a standalone, **fully-owned CDK project** into `infra/` — readable constructs, self-bundling, deployable with plain `cdk deploy`. No laranja required afterward.

```bash
laranja eject
cd infra && npm install && npm run deploy
```

## Roadmap

- [x] `laranja logs` — tail CloudWatch with the same clean UI
- [x] NestJS support (`@Controller`/`@Get` discovery, `@nestjs/schedule` compat, DI-resolved workers)
- [ ] Automated custom domains (CloudFront + ACM + Route 53)
- [ ] Secrets & resource decorators (`@Secret`, `@Table`)

## Local development (monorepo)

```bash
npm install
npm run build            # tsc -b across all packages + build the docs
npm run typecheck        # type-check everything
npm run test             # run the vitest suite
```

Run the CLI against an example without publishing (uses `tsx`, resolving to source):

```bash
tsx packages/cli/src/cli.ts plan examples/expressjs
tsx packages/cli/src/cli.ts plan examples/nestjs
```

## License

TBD — laranja is in early development.
