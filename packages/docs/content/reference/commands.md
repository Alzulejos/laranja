---
title: CLI commands
description: Every laranja command and flag.
order: 1
---

# CLI commands

```
laranja <command> [project-dir] [flags]
```

`project-dir` defaults to the current directory, so most of the time you just run
`laranja deploy`. Run `laranja --help` for a summary.

> **Most commands need your account.** `plan`, `deploy`, and `eject` build your
> template on the laranja server, so they need a `LARANJA_API_KEY` and a
> `projectId` in your config. Run [`laranja init`](#init) once to sign in and link
> a project; the key is stored in `~/.laranja/auth.json` so you don't re-export
> it. Your **source code never leaves your machine** — only a description of your
> infrastructure does
> (see [how it works](../getting-started/how-it-works.md)).

## Global flags

| Flag | Applies to | Description |
|---|---|---|
| `--stage`, `-s <name>` | deploy, plan, destroy, logs, eject | Target [stage](../guides/stages-and-environments.md); overrides `config.stage`. |
| `--verbose`, `-v` | deploy | Stream full CDK/CloudFormation output instead of the compact UI. |
| `--strict` | deploy | Fail if any [`env()`](../guides/environment-variables.md#values-from-your-environment--env) value is unset (default: warn). |

---

## `init`

Sign in and scaffold a `laranja.config.ts` in the project directory.

```bash
laranja init
```

`init` prompts for your **laranja API key** (from the dashboard) and validates it
against the server before writing anything, then stores it in
`~/.laranja/auth.json` so later commands don't need it re-exported. It then lets
you **pick or create a dashboard project** and fills the scaffolded config's
`name` and `projectId` for you. Edit the file afterwards to set your `region`,
`env`, and `compute`. See the [config reference](./config-file.md).

---

## `logout`

Remove the stored API key (`~/.laranja/auth.json`).

```bash
laranja logout
```

After this, commands that talk to the server (`init`, `plan`, `deploy`, `eject`)
need `LARANJA_API_KEY` in the environment again, or another `laranja init`.

---

## `plan`

Preview what a deploy would do — laranja synthesizes your template on the server,
diffs it against the stack **currently deployed** in your AWS account, and prints
your app's resources tagged **created / changed / unchanged**. Nothing is applied.

```bash
laranja plan
laranja plan --stage prod
```

```
Plan for "my-api-dev"

= http     HTTP   2 routes → proxy Lambda + Function URL
+ daily    Cron   Lambda + EventBridge rule
~ emails   Queue  SQS + consumer Lambda

8 AWS resources  +3 created  ~2 changed  =3 unchanged
```

`+` is new, `~` changed, `=` unchanged. The bottom line tallies the underlying
AWS resources.

`plan` needs `LARANJA_API_KEY` (run [`laranja init`](#init) first) to synthesize,
and a working **AWS credential chain** to read your live stack. It is
**read-only** — it never creates a deployment or counts against your deploy limit.

| Flag | Description |
|---|---|
| `--stage`, `-s` | Target stage. |

---

## `deploy`

Deploy into your AWS account using your **local** AWS credentials. The template is
synthesized on the laranja server first, then applied with your own credentials —
so deploy needs both `LARANJA_API_KEY` (run [`laranja init`](#init) first) and a
working AWS credential chain.

```bash
laranja deploy
laranja deploy --stage prod
laranja deploy --verbose
```

- The first deploy to a new account/region prompts to **bootstrap** (a one-time
  setup in your account).
- On success it prints your outputs — the HTTPS URL, queue URLs, and the cron
  jobs deployed.

| Flag | Description |
|---|---|
| `--stage`, `-s` | Target stage. |
| `--verbose`, `-v` | Stream full CDK output. |
| `--strict` | Fail the deploy if any [`env()`](../guides/environment-variables.md#values-from-your-environment--env) value is unset. By default these are deployed with a warning. |

---

## `destroy`

Tear down the deployed stack and all its resources. Prompts for confirmation.

```bash
laranja destroy
laranja destroy --stage prod
```

> Targets the stack for the resolved stage — make sure `--stage` matches the
> environment you intend to remove.

| Flag | Description |
|---|---|
| `--stage`, `-s` | Target stage. |

---

## `logs`

Tail CloudWatch logs for your deployed functions. The live stack is the source of
truth — no local state needed.

```bash
laranja logs                 # interactive picker (TTY)
laranja logs sendEmail       # tail a specific function by name
laranja logs --all           # tail every function, multiplexed
laranja logs --no-follow     # print recent history and exit
laranja logs --since 30m     # history look-back window
laranja logs --stage prod    # functions for the prod stack
```

| Flag / arg | Description |
|---|---|
| `<name>` (positional) | Function to tail (matched against its short label or full name). |
| `--all` | Tail every function in the stack, multiplexed. |
| `--no-follow` | Print the recent history window and exit (no live tail). |
| `--since <dur>` | History look-back, e.g. `30s`, `15m`, `1h`, `2d` (default `1h`). |
| `--stage`, `-s` | Target stage. |

Both a directory and a function name can be passed as positionals —
`laranja logs ./app sendEmail` works.

---

## `eject`

Generate a standalone, owned **CDK project** from your app and stop — for when
you've outgrown the abstraction and want full control. **Paid feature.**

```bash
laranja eject
laranja eject --force      # overwrite an existing ./infra
laranja eject --stage prod
```

The CDK project is generated **on the laranja server** (which gates the paid
entitlement) and written to `./infra` — a complete project you own and run
yourself (`cd infra && npm install && npm run deploy`). Requires `LARANJA_API_KEY`
and a `projectId`; if your account can't eject, the server returns a clear error.

| Flag | Description |
|---|---|
| `--force` | Overwrite an existing `infra/` directory. |
| `--stage`, `-s` | Target stage (baked into the generated project). |

## Related

- [Stages & environments](../guides/stages-and-environments.md)
- [How it works](../getting-started/how-it-works.md)
