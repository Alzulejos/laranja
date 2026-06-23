import { Cron, Queue, rate } from "@alzulejos/laranja-decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() {
    console.log("[refreshCache] running at", new Date().toISOString());
    return { refreshed: true };
  }

  @Queue({ name: "emails", batchSize: 10 })
  async sendEmails(body: unknown) {
    console.log("[sendEmails] processing message:", JSON.stringify(body));
    return { sent: true };
  }
}
