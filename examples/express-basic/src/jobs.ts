import { Cron, Queue, rate, every } from "@alzulejos/laranja-decorators";

export class Jobs {
  @Cron(rate(5, "minutes"))
  async refreshCache() {
    console.log("[refreshCache] running at", new Date().toISOString());
    return { refreshed: true };
  }

  @Cron(every("day"))
  async nightlyCleanup() {
    console.log("[nightlyCleanup] cleaning up old data");
    return { cleaned: 0 };
  }

  @Cron({ schedule: "cron(0 12 * * ? *)", id: "daily-report" })
  async dailyReport() {
    console.log("[dailyReport] generating report for stage:", process.env.STAGE);
    return { report: "sent" };
  }

  @Queue({ name: "emails", batchSize: 10 })
  async sendEmails(body: unknown) {
    console.log("[sendEmails] processing message:", JSON.stringify(body));
    return { sent: true };
  }

  @Queue({ name: "orders.fifo", fifo: true })
  async processOrders(body: unknown) {
    console.log("[processOrders] processing order:", JSON.stringify(body));
    return { processed: true };
  }
}
