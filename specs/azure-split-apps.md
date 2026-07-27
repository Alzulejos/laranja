# Azure: one Function App per workload

**Status:** proposed
**Supersedes:** the single-Function-App model shipped with Azure crons/queues/Nest

## Why

Azure currently deploys **one** Function App hosting everything — the HTTP proxy plus
every cron and queue consumer, from a single package. That was the right v1, but it
has a concrete, user-visible defect:

`laranja-cdk/src/azure/synth.ts` reads `const compute = http?.compute` and applies it
to the whole app. Memory, scale, and log retention are per-Function-App on Flex
Consumption, so **a `workers()` root's `memory`/`timeout` is silently dropped on
Azure** while the same config gives each worker Lambda its own sizing on AWS. Same
code, different behavior per cloud.

Secondary gains: process isolation (a cron that leaks memory can't hurt HTTP latency),
independent scaling, and smaller per-app packages.

The IR already carries what's needed — `WorkersIR.compute` is resolved by the scanner
from `resources[<moduleId>]`. Only the Azure back half ignores it.

## Model

One Function App per **workload**, where a workload is:

- the HTTP app (`http()`), if declared — id `http`
- each `workers()` root — id = the root's `WorkersIR.id`
- standalone function-style `cron()` / `queue()` handlers (no DI) — these stay with
  the HTTP app if there is one, otherwise they form a single `default` workload

That last rule keeps the common case (an Express app with two crons) at **one** app,
exactly as today. Splitting only kicks in for projects that declare `workers()` roots.

### Cold starts, honestly

Splitting raises cold-start **frequency** (a cron-only app scales to zero between
fires instead of possibly riding a warm HTTP instance) but lowers per-cold-start
**cost** (each package carries only its own module's dependencies, not the whole
project's). Net effect is workload-dependent: better for low-traffic projects and for
HTTP latency, worse for crons on a high-traffic app. Lean `workers()` modules are what
make this trade favorable, and the docs should say so.

## Resource split

| Resource | Today | After |
|---|---|---|
| `Microsoft.Web/sites` | 1 | **N** (one per workload) |
| `Microsoft.Web/serverfarms` | 1 | **N**, or 1 shared — see below |
| `Microsoft.Web/sites/config` | 1 | **N** |
| `Microsoft.Authorization/roleAssignments` | 4 | **4N** |
| Storage account + blob container | 1 | 1 (shared) |
| `queueServices/queues` | 1 per queue | unchanged, shared |
| App Insights + Log Analytics | 1 | 1 (shared) |

`roleAssignment()` is already keyed `guid(storageIdExpr, siteIdExpr, roleId)`, so it
parameterizes over the site cleanly — N apps needs no redesign there. (This is *not*
the user-assigned-identity dead end recorded in `azure-monitoring-and-deploy-fixes`;
that was about `reference()` being illegal inside a resource *name*.)

**Every app** gets the full env + queue-name app settings and the storage-queue role,
because any workload's code may call `getQueue().send()`. Don't try to compute which
app produces to which queue — the producer is a runtime call, not a static declaration.

## Naming

Function App names are DNS labels under `*.azurewebsites.net`: globally unique,
lowercase, ≤60 chars. Today: `<name>-<stage>`. Proposed: `<name>-<stage>` for the HTTP
workload (unchanged, so existing deploys don't rename) and `<name>-<stage>-<slug>` for
each `workers()` root, where `slug` is the lowercased root id.

Needs a truncation + hash strategy for long names — put it in `azure/naming.ts` beside
`storageAccountName`, which already solves the same problem.

⚠️ **Renaming an app destroys and recreates it.** Keeping the HTTP app on the existing
name is what makes this a non-breaking upgrade for current users.

## Server changes (`~/dev/laranja-cdk`)

1. Group the IR into workloads (the `Model` section above); emit the per-app resources
   in a loop.
2. Per-app compute: `http.compute` for the HTTP workload, `worker.compute` for each
   root. This is the payoff — delete the "per-resource compute overrides can't be
   honoured here" caveat from the file header.
3. Each app's config gets only ITS triggers' settings (`cronScheduleSettingKey` for its
   crons) plus the shared env/queue settings.
4. Response shape: `names: { functionApp, storageAccount, container }` becomes a
   per-workload map. **Wire-format change — client and server must ship together.**
5. Outputs: `CronCount`/`QueueCount` stay project-wide; add per-app identification so
   the client knows which zip goes where.

## Client changes (`~/dev/laranja`)

1. **codegen** — `generateEntries` emits one Azure entry per workload instead of a
   single `"http"` entry. Each entry registers only its own triggers, with its own
   `nestContext(...)` for its root. Most of this is regrouping logic that already
   exists; the per-root context emission landed with Nest-on-Azure.
2. **bundling** — asset dirs and hashes are free (`bundleEntries` is already
   per-entry), but **not** `host.json`. The function `timeout` is a host.json setting
   living *inside* the package (`buildAzureHostJson`), and `bundleEntries` currently
   takes a single `httpTimeoutSeconds` for every entry. Per-workload `timeout` — half
   the point of this change — needs that to become per-entry.
3. **`deploy-azure.ts`** — currently `assets.find(a => a.id === "http")`, one zip, one
   `oneDeployPublish` against `names.functionApp` (lines 111–175). Becomes a loop:
   zip + publish per app. Publishes should run in parallel; the ARM deployment stays a
   single submission.
4. **`destroy-azure`, `logs-azure`, `plan-azure`, `eject-azure`, `azure-summary`** all
   assume one app today. `logs` in particular needs an app selector or a merged tail.

## Open decisions

- **Partial publish failure.** The ARM deployment is one atomic-ish submission, but the
  N package publishes happen after it. If app 2 of 3 fails, apps 1 and 3 are running new
  code and app 2 is running old. Proposal: publish in parallel, fail the deploy, and
  report exactly which apps did and didn't update. Rolling back the successes is worse
  than reporting honestly.
- **Deploy time.** N zips + N publishes. Parallelism should keep this close to flat, but
  measure before assuming.
- **Flex Consumption plan sharing.** Not a blocker either way: `instanceMemoryMB` and
  `maximumInstanceCount` live in the **site's** `functionAppConfig.scaleAndConcurrency`
  (`synth.ts:516`), not the plan, so per-root compute works whether apps share a plan or
  not. It's purely a resource-count/cost question. Default to one plan per app (simplest,
  certainly legal); collapse to a shared plan later if it proves allowed and worthwhile.

## Sequencing constraint

`laranja-cdk` consumes core as a **published tarball** (currently 0.5.1), not a
workspace link, so it cannot import `azureWorkloads` until core is republished. Either
publish core first, or temporarily mirror the function in `laranja-cdk` the way the
naming helpers already are. Publishing is preferable — the grouping is real logic, and
two copies diverging would put the client and server on different app layouts.

Client and server must ship together regardless: the `/synth` response shape changes.

## Build order

1. ✅ Naming + workload grouping in core (`azureWorkloads`, `azurePlanName` suffix),
   with tests in `test/azure-workloads.test.ts`.
2. ✅ Server: N apps, per-app compute, `names.apps` map. 56 tests green.
3. Client: codegen regrouping, per-entry `host.json` timeout, then the deploy loop.
   ⚠️ **Until this lands, Azure deploys of projects WITH `workers()` roots fail** —
   the server now expects one asset hash per workload and the client still builds one.
   Projects without roots are a single workload and unaffected.
4. The surrounding commands (`logs`, `destroy`, `eject`, summaries).
5. Docs: rewrite "What gets deployed" and the "NestJS workers on Azure" section in
   `guides/deploying-to-azure.md`, including the honest cold-start trade.
