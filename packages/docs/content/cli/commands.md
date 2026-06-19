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

## Global flags

| Flag | Applies to | Description |
|---|---|---|
| `--stage`, `-s <name>` | deploy, synth, diff, destroy, logs, eject | Target [stage](../concepts/stages-and-environments.md); overrides `config.stage`. |
| `--verbose`, `-v` | deploy, destroy | Stream full CDK/CloudFormation output instead of the compact UI. |

---

## `init`

Scaffold a `laranja.config.ts` in the project directory.

```bash
laranja init
```

Creates the config file (and, when connected to the dashboard, validates your
API key and fills in `projectId`). Edit the file to set your `name`, `entry`,
`region`, and `env`. See the [config reference](../configuration/config-file.md).

---

## `synth`

Build your code and show the planned resources — **no AWS calls, no credentials
required**. Useful for previewing a deploy.

```bash
laranja synth
laranja synth --stage prod
```

Prints the plan (routes, crons, queues) and the resource counts, and writes the
generated template under `.laranja/`.

| Flag | Description |
|---|---|
| `--remote` | Synthesize on the laranja server instead of locally. Only the [IR](../concepts/how-it-works.md#2-the-ir-infra-ir) is sent — your source code never leaves your machine. Requires `LARANJA_API_KEY` and a `projectId`. |
| `--stage`, `-s` | Target stage. |

---

## `deploy`

Deploy into your AWS account using your local credentials.

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

---

## `diff`

Show what a deploy would change, compared to what's currently deployed.

```bash
laranja diff
laranja diff --stage prod
```

| Flag | Description |
|---|---|
| `--stage`, `-s` | Target stage. |

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
| `--verbose`, `-v` | Stream full CDK output. |

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

Writes a complete CDK project to `./infra` that you own and run yourself
(`cd infra && npm install && npm run deploy`). Requires a `LARANJA_LICENSE_KEY`.

| Flag | Description |
|---|---|
| `--force` | Overwrite an existing `infra/` directory. |
| `--stage`, `-s` | Target stage (baked into the generated project). |

## Related

- [Stages & environments](../concepts/stages-and-environments.md)
- [How it works](../concepts/how-it-works.md)
