---
title: How it works
seoTitle: How laranja turns your code into cloud infrastructure
description: laranja statically reads your Express or NestJS source to discover routes, crons, and queues, then synthesizes a CloudFormation or ARM template your own CLI deploys. It never runs your code.
order: 4
---

# How it works

laranja **reads** your source to find your HTTP app, cron jobs, queue consumers,
and env vars, then synthesizes a deployment template — CloudFormation on AWS, ARM
on Azure — that your local CLI applies with your own credentials. It never
executes your code, and it never holds your cloud keys. Two things are worth
knowing about that.

## It reads your code — it never runs it

laranja discovers your infrastructure by **reading** your source: your HTTP app
and its routes, your `@Cron` / `cron()` jobs and their schedules, your
`@Queue` / `queue()` consumers, and the env vars you wrap with `env()`. It does
this without executing your code, so planning a deploy is always safe — nothing
of yours runs just to figure out what to deploy.

That's also why a few things must be written so laranja can see them: schedules
use literal builders like `rate(5, "minutes")`, and `env("…")` takes a string
literal.

## It deploys into your own account

laranja turns what it found into real cloud resources — a function serving your
app, a schedule per cron, a queue per consumer — and deploys them with **your**
credentials into **your** account. Which resources depends on the
[`provider`](../reference/config-file.md#provider) you picked; see
[what gets deployed](../reference/what-gets-deployed.md) for the full mapping.

- The provider toolchain is embedded (the AWS CDK toolkit, or ARM for Azure), so
  there's nothing extra to install — no CDK, no CLI, no Bicep.
- [`plan`](../reference/commands.md#plan) previews what a deploy would change
  (created/changed/unchanged); [`destroy`](../reference/commands.md#destroy)
  tears the deployment down.
- Outputs (your HTTPS URL, queue URLs) are printed when the deploy finishes.
- On AWS only, the first deploy to a new account/region runs a one-time
  **bootstrap**.

## The template is built on the server — your code stays local

[`plan`](../reference/commands.md#plan) and [`deploy`](../reference/commands.md#deploy)
synthesize the deployment template on the **laranja server**. laranja scans and
bundles your code locally, then sends only a **description** of your
infrastructure (the internal model plus the asset hashes of your bundles) — your
source code and bundles never leave your machine. The returned template is then
applied to your cloud with your **own** credentials. This is why these commands need a
`LARANJA_API_KEY` and a `projectId` (run [`laranja init`](../reference/commands.md#init)
once to set both up).

## Related

- [What gets deployed](../reference/what-gets-deployed.md)
- [Stages & environments](../guides/stages-and-environments.md)
- [Deploying to Azure](../guides/deploying-to-azure.md)
