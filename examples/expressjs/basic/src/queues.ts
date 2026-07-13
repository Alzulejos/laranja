import { queue } from "@alzulejos/laranja-decorators";

export function welcomeEmailDLQ(payload: any) {
  console.log(`Received DL event at ${Date.toString()}`);
  return true;
}

export function fifoHandler(payload: any) {
  console.log(`Received an event at ${Date.toString()}`);
  return true;
}

export function welcomeEmail(payload: Record<string, any>) {
  console.log(`Sening welcome email to ${payload.userEmail}`);
  return true;
}

queue({ name: "welcomeEmail", batchSize: 5 }, welcomeEmail);
queue({ name: "fifoHandler", batchSize: 1, fifo: true }, fifoHandler);
queue({ name: "welcomeEmailDLQ", batchSize: 1 }, welcomeEmailDLQ);
