# Spec: Azure provider support

Status: **DESIGN** (started 2026-07-21). Branch `feat/azure-support` (monorepo),
`azure-support` (laranja-cdk). Nothing implemented yet.

Prior art: `specs/gcp-provider.md` (built, on branch `feat/GCP-Support`) and
`specs/gcp-be-contract.md`. Read the "what GCP cost us" section below before
re-litigating any engine decision.

## Why Azure fits laranja better than GCP did

AWS gives us a first-party, free, declarative engine (CloudFormation) plus a
readable source language that compiles to it (CDK). **Azure has exactly the same
split** — Bicep compiles to ARM JSON — and GCP has neither.

| | source form | deploy artifact | who deploys | state |
|---|---|---|---|---|
| AWS | CDK | CloudFormation | CDK toolkit | server-side |
| **Azure** | **Bicep** | **ARM JSON** | Azure SDK | **server-side** |
| GCP | — | Terraform JSON | user-installed binary | **local file** |

Verified 2026-07-21: `Azure/bicep` is MIT, not archived, pushed same-day.
`Azure/azure-functions-nodejs-library` likewise. (The CDKTF lesson: check the
repo is alive BEFORE designing on it.)

### Every GCP pain is structural to Terraform, and disappears here

| GCP problem | On Azure |
|---|---|
| State file wiped by our own build step | Gone — ARM state is server-side |
| `env()` secrets in plaintext in local state | Gone — app settings live in Azure |
| Teams need a remote state backend + locking | Gone |
| Terraform is BUSL under IBM | Gone — MIT, first-party |
| User must install `tofu`/`terraform` | Gone — Azure SDK |
| Eject erodes (the artifact IS a working deploy) | Gone — Bicep is source, ARM JSON is artifact |

That last row matters commercially: on GCP `.laranja/tf` is a complete working
deploy we hand over for free, so paid eject loses its point. On Azure the deploy
artifact is machine ARM JSON nobody wants to own, exactly like CloudFormation —
so "eject to readable Bicep" keeps the same value it has on AWS.

## THE structural difference: Azure inverts the function model

Lambda is **one function per handler**; GCP gen2 is the same, which is why that
port was mechanical. **Azure is not.** A *Function App* is one hosting unit
containing *many* functions, each with its own trigger — HTTP routes, timers and
queue consumers all live inside one app.

This is much closer to our Nest `workers()` consolidation than to the Lambda
model. Consequences:

- ONE Function App per project/stage, not N functions.
- ONE zip, ONE set of app settings, ONE cold start shared across handlers.
- `workers()` mostly stops being a special case — everything is consolidated
  already. The DI-root-per-worker design still matters for cold-start isolation,
  but it no longer maps to separate deployed units.
- Per-resource compute config (`resources: { http: { memory } }`) has **no clean
  home**: memory is set per *app*, not per function. Needs a decision — see below.

Flex Consumption does support *per-function scaling* groups (`http`, `durable`,
per-function always-ready counts), so some isolation exists, but it is not the
same as per-function memory/timeout.

## IR → Azure mapping

| IR concept | AWS (built) | Azure |
|---|---|---|
| `http()` app | Lambda + Function URL | Function App + **HTTP trigger** (`app.http`) |
| routes | proxy Lambda | one HTTP trigger, route `{*path}` (proxy model preserved) |
| `@Cron` | EventBridge Scheduler + Lambda | **Timer trigger** (`app.timer`, NCRONTAB) — a binding, NOT a separate resource |
| `@Queue` | SQS + consumer Lambda | **Service Bus queue** + queue trigger |
| queue DLQ | second queue + `maxReceiveCount` | **native dead-letter sub-queue** |
| `workers()` | consolidated worker Lambda | native (the Function App already is this) |
| env (static) | Lambda env | app settings |
| `env("NAME")` | CFN Parameter (NoEcho) | ARM secure parameter → app setting; Key Vault ref later |
| assets | zip → S3 bootstrap bucket | zip → **Blob container**, referenced by the app |
| IAM | Role + PolicyStatement | **Managed identity** + role assignments |
| logs | CloudWatch | **Application Insights** |
| monitoring | CloudWatch dashboard | App Insights / Azure Dashboard |
| account | STS `getAccountId` | **Subscription id** (must be declared, like GCP's project) |
| region | region | location |
| eject | CDK TS project | **Bicep** |

## Scaffolding Azure requires that AWS doesn't

AWS hands us Lambda with nothing underneath. Azure needs, before any of our code
exists: **Resource Group**, **Storage Account** (mandated by the Functions
runtime), **Flex Consumption plan**, **Function App**, and normally
**Application Insights**. Roughly five resources of pure scaffolding, versus
GCP's five *total*.

## Verified facts (2026-07-21, Microsoft Learn)

- **Node 22** is supported on Flex Consumption (`--runtime node --runtime-version 22`).
- **Zip layout — `host.json` AND `package.json` must be at the zip ROOT**, and
  `package.json.main` points at the entry (single file or glob, e.g.
  `dist/src/functions/*.js`). A stray parent folder in the zip (`project/host.json`)
  makes the runtime detect **no functions at all**.
  → Same class of trap as GCP's entry-path problem. Our bundler already controls
  the asset dir, so this is ours to get right; it must be pinned by a test.
- **v4 registration API** (`@azure/functions`, must be a dependency):
  ```js
  const { app } = require("@azure/functions");
  app.http("api",   { methods: ["GET","POST"], handler });
  app.timer("cron1",{ schedule: "0 */5 * * * *", handler });
  ```
  Registration is in code — no `function.json`. v3 and v4 cannot be mixed.
  This mirrors the GCP functions-framework shim, so `codegen.ts` gains a third arm.
- **Deployment**: a Blob container holds the package. Auth is a connection string
  (`DEPLOYMENT_STORAGE_CONNECTION_STRING`) **or** a managed identity holding
  `Storage Blob Data Contributor` on that account. ARM/Bicep can reference the
  package via a `/onedeploy` sub-resource pointing at the blob URL.
- **Instance memory is a FIXED SET, not arbitrary MB** — default `2048`, with
  `512` / `4096` among the options, set per *app*.
  ⚠️ Corrects the initial mapping: `ComputeConfig.memory` is arbitrary on Lambda.
  Needs a decision (below).

## Decisions needed before implementation

1. **`ComputeConfig.memory` → instance size.** Options: (a) AWS-honest-reject on
   Azure like `architecture`/`logRetention`; (b) snap to the nearest supported
   size with a warning; (c) new provider-scoped `azure.instanceMemory`.
   Leaning (b) + warning, since silently ignoring memory is worse and rejecting
   it blocks every project that sets memory at all.
2. **Per-function compute has no Azure home** (memory/timeout are per app).
   Probably reject `resources: {}` overrides on Azure v1 with a clear message.
3. **Timeout** — Flex Consumption's max duration is NOT yet verified. Check
   before mapping `ComputeConfig.timeout`.
4. **Deployment auth** — connection string (simple, but a secret in app settings)
   vs managed identity (correct, more resources). Leaning managed identity, since
   the GCP thread showed how quickly "just put the secret somewhere" compounds.
5. **Queue backend** — Service Bus (closer to SQS, native DLQ) vs Storage Queues
   (cheaper, weaker). Leaning Service Bus; out of v1 scope regardless.

## Proposed scope

**v1 = `http()` + Express only**, matching how GCP was scoped. Crons and queues
are a fast-follow — and cheaper here than on GCP, because timer/queue triggers
are bindings inside the same Function App rather than new infrastructure.

## Workstreams

1. `laranja-cdk`: add `src/azure/` beside `aws/` and `gcp/`; `synth.ts` already
   dispatches on `ir.app.provider`. Emit **ARM JSON** directly (same reasoning as
   the hand-rolled Terraform JSON: we emit a document, we don't need the DSL
   compiler). Bicep is for eject only.
2. Runtime: `registerAzureHttp` in `@alzulejos/laranja-runtime` + a `codegen.ts`
   arm; add `@azure/functions` dep.
3. Bundler: Azure asset layout — `host.json` + `package.json(main)` + bundled
   entry at the zip root. Pin the no-parent-folder rule with a test.
4. Config: `provider: "azure"` requiring `azure: { subscriptionId, resourceGroup? }`
   + `region`. Keep provider settings in their own block (the `projectId` vs
   `gcp.project` collision on GCP is the lesson).
5. CLI executor: Azure SDK — resolve credentials, upload the package to blob,
   create/update the ARM deployment, read outputs. No third-party binary.
6. Server `/synth`: another `artifact` variant — **BE**, same shape as the GCP
   handoff in `specs/gcp-be-contract.md`.

## Validation

GCP's best safety net was running real `tofu validate` against the live provider
schema — it replaced what generated bindings would have caught. The Azure
equivalent is ARM template validation (`az deployment group validate` /
what-if), which needs credentials, so it can't be a plain unit test. Decide
early whether that runs in CI against a scratch subscription, or stays a manual
pre-release check.

## Sources

- <https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node>
- <https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-how-to>
- <https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan>
- <https://github.com/Azure-Samples/azure-functions-flex-consumption-samples>
