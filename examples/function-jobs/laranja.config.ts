import type { LaranjaConfig } from "@alzulejos/laranja-core";

// Function-style workers, no classes. Workers-only (the HTTP API lives elsewhere).
const config: LaranjaConfig = {
  name: "function-jobs",
  region: "eu-central-1",
  http: false,
  env: {
    STAGE: "dev",
  },
};

export default config;
