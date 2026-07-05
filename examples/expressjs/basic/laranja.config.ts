import type { TypedLaranjaConfig } from "./laranja.types.js";

const config: TypedLaranjaConfig = {
  // Both filled in from the dashboard project you pick during `laranja init`.
  name: "",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "",
  region: "eu-central-1",
  env: {},
  // Default compute for every function (the HTTP proxy + each cron/queue).
  compute: { memory: 256, timeout: 30 },
  // Per-resource overrides, keyed by resource id ("http", or a cron/queue id).
  // Filled in once you have resources, e.g.:
  // resources: { cleanup: { memory: 512, timeout: 60 } },
  resources: {
    eventHandler: {
      dlq: {
        queue: "eventsHandlerDLQ",
        maxReceiveCount: 1,
      },
    },
  },
};

export default config;
