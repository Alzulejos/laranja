import { cron, rate } from "@alzulejos/laranja-decorators";

export async function clearCache() {
  console.log(`clearCache ran ${Date.toString()}`);
  return true;
}

cron({ schedule: rate(1, "hour"), id: "clearCacheCron" }, clearCache);

export async function sendOnboardingEmails() {
  console.log(`sendOnboardingEmails ran ${Date.toString()}`);
  return true;
}

cron(
  { schedule: rate(1, "hour"), id: "sendOnboardingEmailsCron" },
  sendOnboardingEmails,
);
