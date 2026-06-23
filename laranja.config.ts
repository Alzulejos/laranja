import type { LaranjaConfig } from "@alzulejos/laranja-core";

const config: LaranjaConfig = {
  name: "my-app",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "20ff5a20-a1e0-4c99-8a1c-4cca9f09461a",
  region: "eu-central-1",
  // Module that exports your framework app (Express in v1).
  entry: "src/app.ts",
  appExport: "app",
  env: {},
};

export default config;
