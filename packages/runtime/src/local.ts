import type { Context, SQSEvent, SQSRecord } from "aws-lambda";
import {
  LOCAL_PROVIDER,
  LOCAL_QUEUE_URL_ENV,
  PROVIDER_ENV_NAME,
  awsCronToStandard,
  localDelayedKey,
  localInflightKey,
  localQueueKey,
  parseScheduleString,
  type LocalQueueMessage,
  type Schedule,
} from "@alzulejos/laranja-core";
import {
  handlerRegistry,
  type CronOptions,
  type QueueOptions,
  type RegisteredHandler,
} from "@alzulejos/laranja-decorators";
import { makeScheduledInvoker, type ScheduledFn, type ScheduledInvoker } from "./scheduled.js";
import { makeQueueConsumer, runSqsBatch, type QueueConsumer } from "./queue.js";

/**
 * How long a received message stays hidden before it is redelivered. Matches the
 * SQS default so local behaviour is the one users will meet in production.
 */
const DEFAULT_VISIBILITY_SECONDS = 30;

/** Deliveries after which a message is dropped rather than retried forever. */
const DEFAULT_MAX_RECEIVE_COUNT = 5;

/** How long to block waiting for a message before looping. */
const POLL_INTERVAL_MS = 500;

export interface StartLocalOptions {
  /**
   * The Nest application (or standalone context) whose DI container owns the
   * `@Cron` / `@Queue` providers.
   *
   * Required for the decorator form: a Nest provider takes its dependencies
   * through the constructor, so it must be resolved from the container rather
   * than instantiated here. Express projects use the function form (`cron(...)`,
   * `queue(...)`) and need nothing.
   */
  app?: { get<T>(type: new (...args: never[]) => T): T };
  /** Log lines for each fire/receive. Defaults to true — this is a dev tool. */
  verbose?: boolean;
}

/** Everything started by `startLocal`, so a caller can shut it down cleanly. */
export interface LocalRuntime {
  stop(): Promise<void>;
}

/**
 * Run this project's crons and queue consumers in the current process, against
 * the services `laranja dev` provisioned.
 *
 * **No-ops unless `LARANJA_PROVIDER=local`.** That is deliberate: the call is
 * meant to be committed in `main.ts` next to `app.listen(...)`, and it must be
 * inert in a deployed function — where EventBridge/Timer triggers and the SQS
 * event source already invoke the same handlers, and a second in-process copy
 * would double-fire every job.
 *
 * @example
 *   const app = await NestFactory.create(AppModule);
 *   await startLocal({ app });
 *   await app.listen(3000);
 */
export async function startLocal(options: StartLocalOptions = {}): Promise<LocalRuntime> {
  if (process.env[PROVIDER_ENV_NAME] !== LOCAL_PROVIDER) {
    return { async stop() {} };
  }
  const verbose = options.verbose ?? true;
  const timers: NodeJS.Timeout[] = [];
  const stops: (() => void)[] = [];

  for (const entry of handlerRegistry) {
    if (entry.kind === "cron") startCron(entry, options, timers, verbose);
  }

  const queues = handlerRegistry.filter((e) => e.kind === "queue");
  let client: Awaited<ReturnType<typeof openRedis>> | undefined;
  if (queues.length > 0) {
    client = await openRedis();
    for (const entry of queues) {
      stops.push(startQueue(entry, options, client, verbose));
    }
  }

  return {
    async stop() {
      for (const t of timers) clearInterval(t);
      for (const s of stops) s();
      await client?.quit();
    },
  };
}

// ---------------------------------------------------------------- crons

function startCron(
  entry: RegisteredHandler,
  options: StartLocalOptions,
  timers: NodeJS.Timeout[],
  verbose: boolean,
): void {
  const opts = entry.options as CronOptions;
  const id = opts.id ?? `${entry.className}-${entry.method}`;
  const schedule = toSchedule(opts.schedule);
  if (!schedule) {
    log(`cron ${id}: unsupported schedule, skipped`);
    return;
  }

  const invoke = async () => {
    const started = Date.now();
    try {
      const fn = resolveScheduled(entry, options);
      await fn({ id, time: new Date().toISOString() }, fakeContext(id));
      if (verbose) log(`cron ${id} ✓ ${Date.now() - started}ms`);
    } catch (err) {
      log(`cron ${id} ✗ ${(err as Error).message}`);
    }
  };

  if (schedule.kind === "rate") {
    const ms = rateToMs(schedule);
    timers.push(setInterval(invoke, ms));
    if (verbose) log(`cron ${id} every ${ms / 1000}s`);
    return;
  }

  // Cron expressions are checked once a minute against the standard-dialect
  // expression rather than scheduled ahead: a dev machine sleeps, and a timer
  // armed for the next occurrence would simply not fire after a lid close.
  const standard = awsCronToStandard(schedule.expression);
  let lastMinute = "";
  timers.push(
    setInterval(() => {
      const now = new Date();
      const minute = `${now.getHours()}:${now.getMinutes()}`;
      if (minute === lastMinute) return;
      lastMinute = minute;
      if (cronMatches(standard, now)) void invoke();
    }, 1000),
  );
  if (verbose) log(`cron ${id} at ${standard}`);
}

/** Minimal 5-field cron matcher: minute hour day-of-month month day-of-week. */
function cronMatches(expression: string, at: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [at.getMinutes(), at.getHours(), at.getDate(), at.getMonth() + 1, at.getDay()];
  return fields.every((field, i) => fieldMatches(field, values[i]));
}

function fieldMatches(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isFinite(step) || step < 1) continue;
    if (range === "*") {
      if (value % step === 0) return true;
      continue;
    }
    const [fromText, toText] = range.split("-");
    const from = Number(fromText);
    const to = toText === undefined ? from : Number(toText);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (value >= from && value <= to && (value - from) % step === 0) return true;
  }
  return false;
}

function toSchedule(input: CronOptions["schedule"]): Schedule | undefined {
  if (typeof input !== "string") return input;
  return parseScheduleString(input);
}

function rateToMs(schedule: Extract<Schedule, { kind: "rate" }>): number {
  const unit = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }[schedule.unit];
  return schedule.value * unit;
}

// ---------------------------------------------------------------- queues

type RedisClient = import("ioredis").Redis;

async function openRedis(): Promise<RedisClient> {
  const url = process.env[LOCAL_QUEUE_URL_ENV];
  if (!url) {
    throw new Error(
      `${LOCAL_QUEUE_URL_ENV} is not set — run \`laranja dev\` and load .laranja/dev.env.`,
    );
  }
  let Redis: typeof import("ioredis").Redis;
  try {
    ({ Redis } = await import("ioredis"));
  } catch {
    throw new Error("Local queues need `ioredis`. Install it in your project: npm i -D ioredis");
  }
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * Poll one queue, driving each message through the same `runSqsBatch` the
 * deployed consumer uses — so a handler that works locally is exercising the
 * production code path, partial-batch-failure semantics included.
 */
function startQueue(
  entry: RegisteredHandler,
  options: StartLocalOptions,
  client: RedisClient,
  verbose: boolean,
): () => void {
  const opts = entry.options as QueueOptions;
  const name = opts.name;
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await promoteDelayed(client, name);
        await reclaimExpired(client, name);
        const raw = await client.rpop(localQueueKey(name));
        if (!raw) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        await deliver(entry, options, client, name, raw, verbose);
      } catch (err) {
        log(`queue ${name} poller error: ${(err as Error).message}`);
        await sleep(POLL_INTERVAL_MS);
      }
    }
  };
  void loop();
  if (verbose) log(`queue ${name} consuming`);
  return () => {
    running = false;
  };
}

async function deliver(
  entry: RegisteredHandler,
  options: StartLocalOptions,
  client: RedisClient,
  name: string,
  raw: string,
  verbose: boolean,
): Promise<void> {
  const message = JSON.parse(raw) as LocalQueueMessage;
  message.receiveCount += 1;

  // Hold the message in-flight before invoking, so a crashed process redelivers
  // it rather than losing it — the guarantee that makes this a queue and not a
  // function call.
  const inflight = JSON.stringify(message);
  await client.zadd(
    localInflightKey(name),
    Date.now() + DEFAULT_VISIBILITY_SECONDS * 1000,
    inflight,
  );

  const consumer = resolveQueue(entry, options);
  const event = toSqsEvent(name, message);
  const result = await runSqsBatch(consumer, event, fakeContext(name));
  const failed = result.batchItemFailures.length > 0;

  await client.zrem(localInflightKey(name), inflight);

  if (!failed) {
    if (verbose) log(`queue ${name} ✓ ${message.id}`);
    return;
  }
  if (message.receiveCount >= DEFAULT_MAX_RECEIVE_COUNT) {
    log(`queue ${name} ✗ ${message.id} dropped after ${message.receiveCount} attempts`);
    return;
  }
  log(`queue ${name} ✗ ${message.id} retry ${message.receiveCount}`);
  await client.lpush(localQueueKey(name), JSON.stringify(message));
}

/** Move any delayed message whose time has come onto the ready list. */
async function promoteDelayed(client: RedisClient, name: string): Promise<void> {
  const due = await client.zrangebyscore(localDelayedKey(name), 0, Date.now(), "LIMIT", 0, 10);
  for (const item of due) {
    const removed = await client.zrem(localDelayedKey(name), item);
    if (removed > 0) await client.lpush(localQueueKey(name), item);
  }
}

/** Return in-flight messages whose visibility timeout expired (i.e. the consumer died). */
async function reclaimExpired(client: RedisClient, name: string): Promise<void> {
  const expired = await client.zrangebyscore(localInflightKey(name), 0, Date.now(), "LIMIT", 0, 10);
  for (const item of expired) {
    const removed = await client.zrem(localInflightKey(name), item);
    if (removed > 0) await client.lpush(localQueueKey(name), item);
  }
}

/**
 * Shape a local message as the SQS record the consumer expects. The fields the
 * runtime actually reads are the body, the message id and the receive count;
 * the rest are filled with plausible values so nothing downstream sees undefined.
 */
function toSqsEvent(name: string, message: LocalQueueMessage): SQSEvent {
  const record: SQSRecord = {
    messageId: message.id,
    receiptHandle: message.id,
    body: message.body,
    attributes: {
      ApproximateReceiveCount: String(message.receiveCount),
      SentTimestamp: String(message.enqueuedAt),
      SenderId: "laranja-dev",
      ApproximateFirstReceiveTimestamp: String(message.enqueuedAt),
    },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: `arn:laranja:local:::${name}`,
    awsRegion: "local",
  };
  return { Records: [record] };
}

// ---------------------------------------------------------------- shared

/**
 * Resolve a registered entry to something callable.
 *
 * The function form carries its own handler. The method form needs the owning
 * class instance, and for Nest that MUST come from the DI container — a
 * provider constructed with `new` here would have every injected dependency
 * undefined, failing at the first use with an error pointing nowhere useful.
 */
function resolveInstance(entry: RegisteredHandler, options: StartLocalOptions): object {
  if (!entry.ctor) throw new Error(`${entry.className}.${entry.method}: no class recorded`);
  if (options.app) return options.app.get(entry.ctor) as object;
  try {
    return new (entry.ctor as new () => object)();
  } catch {
    throw new Error(
      `${entry.className}.${entry.method} needs its Nest provider. Pass your app: startLocal({ app }).`,
    );
  }
}

function resolveScheduled(entry: RegisteredHandler, options: StartLocalOptions): ScheduledInvoker {
  if (entry.handler) return makeScheduledInvoker(entry.handler as ScheduledFn);
  // Bind the DI-resolved instance and hand `makeScheduledInvoker` the function
  // form: its class form would construct the class itself, which is exactly what
  // a Nest provider must not do.
  return makeScheduledInvoker(((event, context) =>
    callMethod(entry, options, [event, context])) as ScheduledFn);
}

function resolveQueue(entry: RegisteredHandler, options: StartLocalOptions): QueueConsumer {
  if (entry.handler) return makeQueueConsumer(entry.handler as QueueConsumer);
  return makeQueueConsumer(((body, record, context) =>
    callMethod(entry, options, [body, record, context])) as QueueConsumer);
}

/** Invoke the decorated method on the instance the DI container owns. */
function callMethod(
  entry: RegisteredHandler,
  options: StartLocalOptions,
  args: unknown[],
): unknown {
  const instance = resolveInstance(entry, options) as Record<string, unknown>;
  const fn = instance[entry.method];
  if (typeof fn !== "function") {
    throw new Error(`${entry.className}.${entry.method} is not a method`);
  }
  return (fn as (...a: unknown[]) => unknown).apply(instance, args);
}

/** Minimal Lambda context stand-in — enough for handlers that read the name/id. */
function fakeContext(name: string): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: name,
    functionVersion: "local",
    invokedFunctionArn: `arn:laranja:local:::${name}`,
    memoryLimitInMB: "1024",
    awsRequestId: `local-${Date.now()}`,
    logGroupName: "laranja-dev",
    logStreamName: "laranja-dev",
    getRemainingTimeInMillis: () => 30_000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(message: string): void {
  console.log(`[laranja] ${message}`);
}
