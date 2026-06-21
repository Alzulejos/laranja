---
title: How it works
description: How laranja turns your code into a running app on AWS.
order: 1
---

# How it works

You write your app; laranja deploys it to your own AWS account. Two things are
worth knowing about how it does that.

## It reads your code — it never runs it

laranja discovers your infrastructure by **reading** your source: your HTTP app
and its routes, your `@Cron` / `cron()` jobs and their schedules, your
`@Queue` / `queue()` consumers, and the env vars you wrap with `env()`. It does
this without executing your code, so planning a deploy is always safe — nothing
of yours runs just to figure out what to deploy.

That's also why a few things must be written so laranja can see them: schedules
use literal builders like `rate(5, "minutes")`, and `env("…")` takes a string
literal.

## It deploys into your AWS account

laranja turns what it found into AWS resources — a Lambda for your app, an
EventBridge rule per cron, an SQS queue per consumer — and deploys them with
**your** credentials into **your** account. See
[what gets deployed](./what-gets-deployed.md) for the full mapping.

- The AWS CDK toolkit is embedded, so there's nothing extra to install.
- The first deploy to a new account/region runs a one-time **bootstrap**.
- [`diff`](../cli/commands.md#diff) previews changes before you apply them;
  [`destroy`](../cli/commands.md#destroy) tears the stack down.
- Outputs (your HTTPS URL, queue URLs) are printed when the deploy finishes.

Prefer to keep the heavy lifting off your machine?
[`synth --remote`](../cli/commands.md#synth) builds your code locally and sends
only a description of your infrastructure to the laranja server — your source
code and bundles never leave your machine.

## Related

- [What gets deployed](./what-gets-deployed.md)
- [Stages & environments](./stages-and-environments.md)
