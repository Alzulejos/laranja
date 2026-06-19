import type { LaranjaConfig } from "@laranja/core";

const config: LaranjaConfig = {
  name: "my-app",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "ec8b5552-02cb-4385-b0a8-544597e4766d",
  region: "us-east-1",
  // Module that exports your framework app (Express in v1).
  entry: "src/app.ts",
  appExport: "app",
  env: {},
};

export default config;
