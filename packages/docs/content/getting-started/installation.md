---
title: Installation
description: Prerequisites and how to add laranja to a project.
order: 2
---

# Installation

## Prerequisites

Whichever cloud you target:

- **Node.js 22 or newer.** Deployed functions run on the Node.js 22 runtime, and
  the CLI targets the same.
- **A laranja account + API key.** laranja synthesizes your deployment template on
  its server, so `plan`, `deploy`, and `eject` need an API key (created in the
  dashboard) and a project to link to. You connect both by running
  [`laranja init`](./quickstart.md#3-sign-in-and-configure) — see the Quickstart.
- **An account with the cloud you're deploying to**, and credentials for it on
  that cloud's standard chain (below).

### AWS (the default)

- Credentials on the standard AWS chain — any of:
  - `aws configure` (a shared credentials file),
  - AWS SSO (`aws sso login`),
  - environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`),
  - a named profile (set [`profile`](../reference/config-file.md#region-and-profile) in config).
- **A region**, from [`region`](../reference/config-file.md#region-and-profile) in
  your config or the `AWS_REGION` / `AWS_DEFAULT_REGION` environment variable.

You do **not** need to install the AWS CDK or the AWS CLI separately — the CDK
toolkit is embedded in laranja.

### Azure

- Credentials on the standard `DefaultAzureCredential` chain — `az login`
  locally, or a service principal via `AZURE_*` env vars in CI.
- A **subscription** and an **already-existing resource group**, set under
  [`azure`](../reference/config-file.md#azure) in your config.

You do **not** need Bicep, ARM templates, or the Azure Functions Core Tools.
Full setup — including the resource providers to register — is in
**[Deploying to Azure](../guides/deploying-to-azure.md#prerequisites)**.

`laranja deploy` runs a **preflight** for whichever provider you're on and prints
the exact command to fix anything missing, so you find out before it touches the
cloud.

## Install

Add the CLI as a dev dependency:

```bash
npm install -D @alzulejos/laranja
```

If you use decorators or function markers for jobs and queues, also install:

```bash
npm install @alzulejos/laranja-decorators
```

> `@alzulejos/laranja-decorators` is a regular dependency (not dev-only) because your
> application imports `@Cron`, `@Queue`, `rate`, etc. at runtime.

## First-time setup

On **AWS**, the first deploy to a given account + region runs a one-time
**bootstrap** that creates a small set of shared resources in _your_ account (an
S3 asset bucket and a few IAM roles). `laranja deploy` detects this and prompts
you before doing it — see [deploy](../reference/commands.md#deploy).

On **Azure** there's no bootstrap; the resource group you point at is the only
thing that has to exist up front.

## Verify

```bash
npx laranja --help
```

You're ready for the **[Quickstart](./quickstart.md)**.
