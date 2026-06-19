---
title: How it works
description: The scan → IR → synth → deploy pipeline, end to end.
order: 1
---

# How it works

laranja turns your application code into deployed infrastructure in four stages:

```
  your code  →  scan  →  IR  →  synth  →  deploy
              (read)  (plan)  (template)  (apply)
```

## 1. Scan

A **static scanner** (built on `ts-morph`) reads your source without executing
it. It finds:

- the **HTTP app** (from `entry`/`appExport` or the [`http()`](../reference/decorators-and-markers.md#http) marker) and its routes,
- every [`@Cron`](../reference/decorators-and-markers.md#cron) / [`cron()`](../reference/decorators-and-markers.md#cron-marker) handler and its schedule,
- every [`@Queue`](../reference/decorators-and-markers.md#queue) / [`queue()`](../reference/decorators-and-markers.md#queue-marker) handler and its options.

Because it's static, schedule builders like `rate(5, "minutes")` are
constant-folded at scan time — your code is never run to discover infrastructure.

## 2. The IR (Infra IR)

The scan produces an **Infra IR** — a small, serializable, provider-neutral
description of what your app needs: "one HTTP app with N routes, these crons on
these schedules, these queues." It contains _structure only_ — names, routes,
schedules, env keys — never your source code.

The IR is the seam that makes everything else possible:

- It's **provider-neutral**, so the same description can target different clouds.
- It's the **only thing that needs to cross a network boundary** when synth runs
  on a server (see below).

## 3. Synth

The IR is **synthesized** into a concrete deployment artifact — a CloudFormation
template (via the AWS CDK under the hood). This is where the abstract "one cron
on a 5-minute schedule" becomes a Lambda function, an IAM role, and an
EventBridge rule. See [what gets deployed](./what-gets-deployed.md) for the
full mapping.

Two synth modes exist:

- **Local** — the default; everything happens on your machine.
- **Server-side** ([`synth --remote`](../cli/commands.md#synth)) — your machine
  builds the code and sends only the IR to the laranja server, which returns the
  template. Your source code and built artifacts never leave your machine.

## 4. Deploy

Your built code is bundled into Lambda packages, and the template is applied to
**your own AWS account** using your credentials. laranja embeds the AWS CDK
toolkit, so there's nothing else to install.

- The first deploy to a new account/region runs a one-time **bootstrap**.
- Outputs (your HTTPS URL, queue URLs) are surfaced when the deploy finishes.
- [`diff`](../cli/commands.md#diff) shows what a deploy would change before you
  run it; [`destroy`](../cli/commands.md#destroy) tears the stack down.

## Why this shape

Reducing the app to an IR — and keeping synth logic behind a clean boundary —
means the front half (reading your code) is fully decoupled from the back half
(generating infrastructure). That's what lets laranja add new clouds or move
synth server-side without changing how you write your app.

## Related

- [What gets deployed](./what-gets-deployed.md)
- [Stages & environments](./stages-and-environments.md)
