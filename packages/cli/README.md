# @alzulejos/laranja

The `laranja` command — code-first deploys for Node.js apps to **your own AWS or
Azure account**.

```bash
npm install -D @alzulejos/laranja
npx laranja deploy
```

```
laranja init       sign in + scaffold laranja.config.ts, link a dashboard project
laranja plan       preview the planned resources, diff against what's live
laranja deploy     deploy into your own cloud account
laranja destroy    tear it all down
laranja logs       tail your functions' logs
laranja eject      generate an owned infrastructure project (Pro)
laranja logout     remove the stored API key

--stage, -s <name> target a stage (dev/staging/prod); overrides config
--verbose, -v      stream full provider output
```

Each stage is an independent deployment (`‹name›-‹stage›`), so one repo can drive
separate dev/staging/prod pipelines — `laranja deploy --stage prod`.

Pick your cloud with one config field:

```ts
// laranja.config.ts
const config: LaranjaConfig = { name: "my-api", projectId: "proj_…" };          // AWS (default)
const config: LaranjaConfig = { name: "my-api", projectId: "proj_…", provider: "azure", /* … */ };
```

Requires Node 22+ and credentials for your provider on its standard chain — AWS
(`aws configure` / SSO / `AWS_*`) or Azure (`az login` / `AZURE_*`). The AWS CDK
toolkit is embedded and Azure deploys via ARM, so there's nothing else to install.

This README is a summary — every command, flag, and config field is documented in
the official docs.

📖 **Full docs:** https://laranja.io/docs
