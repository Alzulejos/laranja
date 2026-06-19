---
title: Installation
description: Prerequisites and how to add laranja to a project.
order: 1
---

# Installation

## Prerequisites

- **Node.js 20 or newer.** Deployed Lambdas run on the Node.js 20 runtime, and
  the CLI targets the same.
- **An AWS account** plus credentials on the standard AWS chain — any of:
  - `aws configure` (a shared credentials file),
  - AWS SSO (`aws sso login`),
  - environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`),
  - a named profile (set [`profile`](../configuration/config-file.md) in config).
- **A region**, from `region` in your config or the `AWS_REGION` /
  `AWS_DEFAULT_REGION` environment variable.

You do **not** need to install the AWS CDK or the AWS CLI separately — the CDK
toolkit is embedded in laranja.

## Install

Add the CLI as a dev dependency:

```bash
npm install -D @laranja/cli
```

If you use decorators or function markers for jobs and queues, also install:

```bash
npm install @laranja/decorators
```

> `@laranja/decorators` is a regular dependency (not dev-only) because your
> application imports `@Cron`, `@Queue`, `rate`, etc. at runtime.

## First-time AWS setup (bootstrap)

The first time you deploy to a given account + region, laranja runs a one-time
**bootstrap** that creates a small set of shared resources in _your_ account (an
S3 asset bucket and a few IAM roles). `laranja deploy` detects this and prompts
you before doing it — see [deploy](../cli/commands.md#deploy).

## Verify

```bash
npx laranja --help
```

You're ready for the **[Quickstart](./quickstart.md)**.
