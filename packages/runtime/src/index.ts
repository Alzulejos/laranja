export { createHttpHandler } from "./http.js";
export type { FrameworkApp } from "./http.js";
export { createScheduledHandler } from "./scheduled.js";
export { createQueueHandler } from "./queue.js";
export type { QueueConsumer } from "./queue.js";

// Build-time codegen (not used inside the Lambda, but co-located because it
// generates code that imports the factories above).
export { generateEntries } from "./codegen.js";
export type { GeneratedEntry, GenerateEntriesOptions } from "./codegen.js";
