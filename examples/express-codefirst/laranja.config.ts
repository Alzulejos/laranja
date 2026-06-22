import type { LaranjaConfig } from "@laranja/core";

const config: LaranjaConfig = {
  name: "express-codefirst",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "20ff5a20-a1e0-4c99-8a1c-4cca9f09461a",
  region: "eu-central-1",
  // No `entry`: the app is declared in code via the `http(app)` marker in src/app.ts.
  env: {},
};

export default config;
