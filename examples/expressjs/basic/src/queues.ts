import { queue } from "@alzulejos/laranja-decorators";

export function eventsHandler(payload: any) {
  console.log(`Received an event at ${Date.toString()}`);
  return true;
}

queue({ name: "eventHandler", batchSize: 5 }, eventsHandler);

export function eventsHandlerDLQ(payload: any) {
  console.log(`Received DL event at ${Date.toString()}`);
  return true;
}

queue({ name: "eventsHandlerDLQ", batchSize: 5 }, eventsHandlerDLQ);

export function fifoHandler(payload: any) {
  console.log(`Received an event at ${Date.toString()}`);
  return true;
}

queue({ name: "fifoHandler", batchSize: 1, fifo: true }, fifoHandler);

export function welcomeEmail(userEmail: string) {
  console.log(`Sening welcome email to ${userEmail}`);
  return true;
}

queue({ name: "welcomeEmail", batchSize: 5 }, welcomeEmail);
