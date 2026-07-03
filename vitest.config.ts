import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Scanner/config tests touch the filesystem (ts-morph reads sources, loadConfig
    // dynamically imports configs); keep them on the Node environment.
    environment: "node",
  },
});
