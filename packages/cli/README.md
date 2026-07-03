# @laranja/cli

The `laranja` command — code-first deploys for Node.js apps to your own AWS account.

```bash
npm install -D @laranja/cli
npx laranja deploy
```

```
laranja init       scaffold laranja.config.ts
laranja synth      build & print planned resources (no AWS calls)
laranja deploy     deploy into your AWS account
laranja diff       diff plan vs. deployed
laranja destroy    tear down
laranja eject      generate an owned CDK project (Pro)

--stage, -s <name> target a stage (dev/staging/prod); overrides config
--verbose, -v      stream full CDK/CloudFormation output
```

Each stage is its own CloudFormation stack (`‹name›-‹stage›`), so one repo can
drive separate dev/staging/prod pipelines — `laranja deploy --stage prod`.

Requires Node 20+ and AWS credentials on the standard chain (`aws configure` / SSO / `AWS_*`). The AWS CDK toolkit is embedded — no separate install.

📖 **Full docs:** https://github.com/your-org/laranja
