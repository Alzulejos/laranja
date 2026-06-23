import { cron, rate } from "@alzulejos/laranja-decorators";

// A function-style worker living alongside the HTTP app — both declared in code.
export async function refreshCache() {
  console.log("[refreshCache] running at", new Date().toISOString());
  return { refreshed: true };
}

cron(rate(10, "minutes"), refreshCache);
