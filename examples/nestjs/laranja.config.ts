import type { TypedLaranjaConfig } from "./laranja.types.js";

const config: TypedLaranjaConfig = {
  // Both filled in from the dashboard project you pick during `laranja init`.
  name: "nestjs",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "ea40244a-a913-4b3e-b7c4-e8c19fceb211",
  region: "eu-central-1",
  env: {},
  // Emit a CloudWatch dashboard (`<name>-<stage>`) with per-function metrics —
  // invocations, errors, throttles, duration. Set false to skip it. Defaults to true.
  monitoring: true,
  // Default compute for every function (the HTTP proxy + each cron/queue).
  compute: { memory: 256, timeout: 30 },
  // Per-resource overrides, keyed by resource id ("http", or a cron/queue id).
  // Filled in once you have resources, e.g.:
  // resources: { cleanup: { memory: 512, timeout: 60 } },
};

export default config;
