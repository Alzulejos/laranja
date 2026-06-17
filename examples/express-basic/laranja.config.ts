import type { LaranjaConfig } from "@laranja/core";

const config: LaranjaConfig = {
  name: "express-basic",
  region: "eu-central-1",
  entry: "src/app.ts",
  appExport: "app",
  env: {
    STAGE: "dev",
  },
};

export default config;
