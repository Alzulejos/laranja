import { cron, queue, rate } from "@laranja/decorators";

// Plain exported functions — no class needed. The function name becomes the
// resource id. Each registration below is read statically by the scanner.

export async function refreshCache() {
  console.log("[refreshCache] running at", new Date().toISOString());
  return { refreshed: true };
}

export async function dailyReport() {
  console.log("[dailyReport] generating report for stage:", process.env.STAGE);
  return { report: "sent" };
}

export async function sendEmails(body: unknown) {
  console.log("[sendEmails] processing message:", JSON.stringify(body));
  return { sent: true };
}

cron(rate(5, "minutes"), refreshCache);
cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" }, dailyReport);
queue({ name: "emails", batchSize: 10 }, sendEmails);
