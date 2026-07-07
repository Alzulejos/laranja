# @alzulejos/laranja

The `laranja` command — code-first deploys for Node.js apps to your own AWS account.

```bash
npm install -D @alzulejos/laranja
npx laranja deploy
```

```
laranja init       sign in + scaffold laranja.config.ts, link a dashboard project
laranja plan       preview the planned resources, diff against the live stack
laranja deploy     deploy into your AWS account
laranja destroy    tear it all down
laranja logs       tail CloudWatch logs for a deployed function
laranja eject      generate an owned CDK project (Pro)
laranja logout     remove the stored API key

--stage, -s <name> target a stage (dev/staging/prod); overrides config
--verbose, -v      stream full CDK/CloudFormation output
```

Each stage is its own CloudFormation stack (`‹name›-‹stage›`), so one repo can
drive separate dev/staging/prod pipelines — `laranja deploy --stage prod`.

Requires Node 20+ and AWS credentials on the standard chain (`aws configure` / SSO / `AWS_*`). The AWS CDK toolkit is embedded — no separate install.

📖 **Full docs:** https://laranja.io/docs
