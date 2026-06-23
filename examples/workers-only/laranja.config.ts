import type { LaranjaConfig } from "@alzulejos/laranja-core";

// Workers-only: the team's HTTP API lives elsewhere. laranja deploys only the
// @Cron / @Queue handlers — no proxy Lambda, no Function URL.
const config: LaranjaConfig = {
  name: "workers-only",
  region: "eu-central-1",
  http: false,
  env: {
    STAGE: "dev",
  },
};

export default config;
