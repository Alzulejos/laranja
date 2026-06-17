import type { LaranjaConfig } from "@laranja/core";

// Fully code-first: no `entry`/`appExport` here — the HTTP app is marked in code
// with `http(app)`. Config carries only deployment settings.
const config: LaranjaConfig = {
  name: "express-codefirst",
  region: "eu-central-1",
  env: {
    STAGE: "dev",
  },
};

export default config;
