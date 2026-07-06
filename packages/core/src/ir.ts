/**
 * The Infra IR is the serializable boundary between the front half of the tool
 * (scanning user source) and the back half (generating + deploying CDK).
 *
 * Everything downstream depends only on this shape — never on ts-morph nodes or
 * the user's source tree. This is what lets us later move CDK synth server-side
 * (free tier) vs. local eject (paid) without touching the scanner.
 */

import type { Schedule } from "./schedule.js";

export type Framework = "express" | "nest";

/**
 * Target cloud. Only "aws" is implemented today; the rest are planned. The field
 * lives in the IR so server-side synth can dispatch to the right back-half and
 * configs written today stay forward-compatible.
 */
export type CloudProvider = "aws" | "azure" | "gcp" | "cloudflare";

/**
 * Runtime config shared by every function-backed resource — the HTTP proxy and
 * each cron/queue consumer all become a function, so they all carry this.
 *
 * Sourced from the config's global `compute` defaults, overridden per-resource by
 * `resources[id]`; the scanner merges the two and attaches the result here. Each
 * field maps to a real knob on AWS Lambda, GCP Cloud Functions, and Azure
 * Functions — except the two flagged AWS-honest, which a future provider union
 * rejects on non-AWS targets rather than fake-abstracting.
 */
export interface ComputeConfig {
  /** Memory in MB. */
  memory?: number;
  /** Max wall-clock seconds per invocation. */
  timeout?: number;
  /** Cap on simultaneous executions (AWS reserved concurrency / GCP maxInstances). */
  maxConcurrency?: number;
  /** CPU architecture. AWS-honest. */
  architecture?: "x86_64" | "arm64";
  /** Log retention in days. AWS-honest (CloudWatch log group). */
  logRetention?: number;
}

/** A point in the user's source, for diagnostics / visibility. e.g. "src/jobs.ts:12" */
export type SourceLocation = string;

/** A decorated method on a class: `class Jobs { @Cron() method() {} }`. */
export interface MethodTarget {
  style: "method";
  /** Project-relative path to the file declaring the class. */
  file: string;
  /** Class the method lives on. */
  className: string;
  /** Method name to invoke. */
  method: string;
  /** Source location for diagnostics. */
  source: SourceLocation;
}

/** An exported function registered via `cron(...)` / `queue(...)`. */
export interface FunctionTarget {
  style: "function";
  /** Project-relative path to the file declaring the function. */
  file: string;
  /** Exported name of the handler function to import. */
  exportName: string;
  /** Source location for diagnostics. */
  source: SourceLocation;
}

/**
 * Reference to the user code that becomes an isolated Lambda. Either a method on
 * a class (decorator style) or a standalone exported function (marker style).
 */
export type HandlerRef = MethodTarget | FunctionTarget;

/** The natural handler name: method name (class style) or export name (function style). */
export function handlerName(ref: HandlerRef): string {
  return ref.style === "function" ? ref.exportName : ref.method;
}

/** The id a handler gets when the user doesn't set an explicit one. */
export function defaultHandlerId(ref: HandlerRef): string {
  return ref.style === "function" ? ref.exportName : `${ref.className}-${ref.method}`;
}

/** Lambda label: the natural handler name, unless the user set a custom id. */
export function handlerLabel(item: HandlerRef & { id: string }): string {
  return item.id === defaultHandlerId(item) ? handlerName(item) : item.id;
}

/** A discovered HTTP route. In v1 all routes are served by ONE proxy Lambda; */
/** routes are captured for visibility / validation / future per-route IAM. */
export interface HttpRoute {
  method: string;
  path: string;
  source: SourceLocation;
}

export interface HttpIR {
  /** Project-relative module that exports the framework app (the proxy target). */
  handlerEntry: string;
  /** Named export of the app within `handlerEntry` (e.g. "app" or "default"). */
  appExport: string;
  routes: HttpRoute[];
  /** Resolved compute config for the proxy function (keyed as "http" in `resources`). */
  compute?: ComputeConfig;
}

/**
 * A `workers(SomeModule)` marker: a Nest module the worker Lambdas build a
 * standalone DI context from, so class-based @Cron/@Queue providers resolve their
 * injected dependencies. Absent for Express (no DI) and workers-free projects.
 *
 * A project may declare several — one per disjoint DI root (e.g. a queues module
 * and a crons module) — so each worker Lambda boots only the graph it needs and
 * pays a smaller cold start. Each method-style cron/queue names its root via
 * `workersId`.
 */
export interface WorkersIR {
  /** Stable id — the root module's class name; what handlers point `workersId` at. */
  id: string;
  /** Project-relative module that exports `workers(SomeModule)`. */
  handlerEntry: string;
  /** Named export within that module (e.g. "default" or "jobs"). */
  appExport: string;
}

/** @Cron(...) / cron(...) -> scheduled trigger -> its own Lambda. */
export type CronIR = HandlerRef & {
  /** Stable logical id, used for the CDK construct + function name. */
  id: string;
  /** Provider-neutral schedule; the back half lowers it to the target's syntax. */
  schedule: Schedule;
  /** IANA timezone for the schedule (needs EventBridge Scheduler, not Rules). */
  timezone?: string;
  /** Async-invoke retry attempts (AWS allows 0–2). */
  retryAttempts?: number;
  /** Max age (seconds) of an event before async retries are abandoned. */
  maxEventAge?: number;
  /** Dead-letter failed async invokes to another declared queue, referenced by id. */
  dlq?: { queue: string };
  /** Resolved compute config for this cron's function. */
  compute?: ComputeConfig;
  /** Method-style Nest crons only: id of the WorkersIR DI root that owns this provider. */
  workersId?: string;
};

/** @Queue({ name }) / queue(...) -> SQS queue -> its own consumer Lambda. */
export type QueueIR = HandlerRef & {
  id: string;
  /** Queue name. A ".fifo" suffix or fifo:true marks a FIFO queue. */
  name: string;
  batchSize?: number;
  fifo?: boolean;
  /** FIFO content-based dedup (FIFO-only). Defaults to true for FIFO when unset. */
  contentBasedDedup?: boolean;
  /** Seconds a message stays hidden while being processed (AWS requires >= timeout). */
  visibilityTimeout?: number;
  /** Seconds to wait gathering a fuller batch before invoking the consumer. */
  maxBatchingWindow?: number;
  /** Report per-message failures so only failed items are retried, not the batch. */
  reportBatchItemFailures?: boolean;
  /** Seconds an undelivered message is retained on the source queue. */
  messageRetention?: number;
  /** Dead-letter after N failed receives to another declared queue, referenced by id. */
  dlq?: { maxReceiveCount: number; queue: string };
  /** Resolved compute config for this queue's consumer function. */
  compute?: ComputeConfig;
  /** Method-style Nest queues only: id of the WorkersIR DI root that owns this provider. */
  workersId?: string;
};

export interface InfraIR {
  app: {
    name: string;
    framework: Framework;
    /** Target cloud. Defaults to "aws". */
    provider: CloudProvider;
    /** Deployment stage; part of resource names. */
    stage: string;
    /**
     * Emit a per-app-stage monitoring dashboard. Provider-neutral; the back half
     * maps it to its own primitives (CloudWatch dashboard on AWS). Defaults to true.
     */
    monitoring: boolean;
    /** Project-relative app entry (same as http.handlerEntry). Absent for workers-only apps. */
    entry?: string;
  };
  /** Absent when there's no `http()` marker — a workers-only deployment. */
  http?: HttpIR;
  /**
   * Nest DI roots for class-based workers; absent for Express / function-only apps.
   * One entry per `workers()` marker — a project can run disjoint DI graphs so each
   * worker Lambda boots only its own module (smaller cold starts). Method-style
   * crons/queues bind to a root via `workersId`.
   */
  workers?: WorkersIR[];
  crons: CronIR[];
  queues: QueueIR[];
  /**
   * Static env from config, injected into every Lambda as literal name->value.
   * Crosses the wire to the server as-is. Secrets handling comes later.
   */
  env: Record<string, string>;
  /**
   * Env var NAMES discovered from `env("NAME")` calls in user code (names only,
   * never values). The client resolves each from `process.env` at deploy time
   * and injects it into every Lambda — so values stay on the developer's machine
   * (and out of the IR, the wire, and the server). Sorted + de-duplicated.
   */
  envKeys: string[];
}
