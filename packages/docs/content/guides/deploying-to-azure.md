---
title: Deploying to Azure
description: Deploy an Express app and its environment variables to your own Azure subscription.
order: 7
---

# Deploying to Azure

laranja can deploy to **your own Azure subscription** as an alternative to AWS.
The model is the same one you already know — you write the app, laranja reads the
code and ships the infrastructure — only the back half targets Azure instead.

> **What's supported today:** **Express HTTP apps** and **environment variables**,
> at full parity with AWS. **Crons and queues** (`@Cron` / `@Queue` / `cron()` /
> `queue()`) and **NestJS** are AWS-only for now — Azure timer and Service Bus
> triggers are a fast-follow. Deploy those workloads to AWS in the meantime.

## Prerequisites

- **An Azure subscription** and a **resource group that already exists** — laranja
  deploys _into_ a group, it doesn't create one. Note the subscription id
  (`az account show --query id -o tsv`) and the group name.
- **Azure credentials** on the standard chain (`DefaultAzureCredential`): env
  vars, a managed identity, or `az login`. Locally, `az login` is enough; in CI,
  set a service principal via the `AZURE_*` environment variables.
- **A region that offers Flex Consumption** and is accepting new customers —
  `westus2` is a safe default. laranja runs Express on the Azure Functions
  **Flex Consumption** plan.

You do **not** need Bicep, ARM templates, or the Azure Functions Core Tools —
laranja synthesizes and submits the ARM deployment for you.

## Configure

Point your config at Azure and add the `azure` block:

```ts
// laranja.config.ts
import type { LaranjaConfig } from "@alzulejos/laranja-decorators";

const config: LaranjaConfig = {
  name: "my-api",
  projectId: "proj_…",
  provider: "azure",
  region: "westus2",
  azure: {
    subscriptionId: "00000000-0000-0000-0000-000000000000",
    resourceGroup: "my-existing-group",
  },
  env: { LOG_LEVEL: "info" },
};

export default config;
```

Or run [`laranja init`](../reference/commands.md#init), choose **Azure** when
prompted, and it fills in the subscription, group, and region for you.

See [`azure`](../reference/config-file.md#azure) in the config reference for the
field details.

## Deploy

Same commands as everywhere else:

```bash
npx laranja deploy
```

laranja provisions the infrastructure with an ARM deployment, then publishes your
app; when it finishes you get a public `https://‹app›.azurewebsites.net` URL.
[`plan`](../reference/commands.md#plan), [`logs`](../reference/commands.md#logs),
and [`destroy`](../reference/commands.md#destroy) all work against Azure too.

## Environment variables

Environment variables behave exactly as described in
[Environment variables](./environment-variables.md) — both the static `env` map
and code-discovered `env("…")` values. On Azure they land in the Function App's
**application settings** instead of a Lambda's environment, and are available
through `process.env` the same way. The same rules apply: missing values only
warn (pass `--strict` to fail), and previously deployed values are kept on a
re-deploy that doesn't re-supply them.

> Application settings are stored in plaintext, readable by anyone with access to
> the Function App's configuration — the same caveat as AWS Lambda env. For true
> secrets, read them at runtime from a secret store (Azure Key Vault) inside your
> handler. First-class secrets support is on the roadmap.

## What gets deployed

A single **Function App** on the Flex Consumption plan hosts your Express app,
alongside the resources it needs, all inside your resource group:

- a **Function App** (`Microsoft.Web/sites`) + its Flex Consumption plan,
- a **storage account** for the deployment package,
- **Application Insights** + a **Log Analytics workspace** that back
  [`laranja logs`](../reference/commands.md#logs).

Everything is named after your `name` and `stage`, and torn down together by
[`destroy`](../reference/commands.md#destroy).

## Related

- [Config file](../reference/config-file.md#azure)
- [Environment variables](./environment-variables.md)
- [HTTP apps](./http-apps.md)
