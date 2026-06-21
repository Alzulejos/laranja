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
}

/** @Cron(...) / cron(...) -> scheduled trigger -> its own Lambda. */
export type CronIR = HandlerRef & {
  /** Stable logical id, used for the CDK construct + function name. */
  id: string;
  /** Provider-neutral schedule; the back half lowers it to the target's syntax. */
  schedule: Schedule;
};

/** @Queue({ name }) / queue(...) -> SQS queue -> its own consumer Lambda. */
export type QueueIR = HandlerRef & {
  id: string;
  /** Queue name. A ".fifo" suffix or fifo:true marks a FIFO queue. */
  name: string;
  batchSize?: number;
  fifo?: boolean;
};

export interface InfraIR {
  app: {
    name: string;
    framework: Framework;
    /** Target cloud. Defaults to "aws". */
    provider: CloudProvider;
    /** Deployment stage; part of resource names. */
    stage: string;
    /** Project-relative app entry (same as http.handlerEntry). Absent for workers-only apps. */
    entry?: string;
  };
  /** Absent when HTTP is disabled (`http: false`) — a workers-only deployment. */
  http?: HttpIR;
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
