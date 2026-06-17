/**
 * The Infra IR is the serializable boundary between the front half of the tool
 * (scanning user source) and the back half (generating + deploying CDK).
 *
 * Everything downstream depends only on this shape — never on ts-morph nodes or
 * the user's source tree. This is what lets us later move CDK synth server-side
 * (free tier) vs. local eject (paid) without touching the scanner.
 */

export type Framework = "express" | "nest";

/** A point in the user's source, for diagnostics / visibility. e.g. "src/jobs.ts:12" */
export type SourceLocation = string;

/** Reference to a decorated method that becomes an isolated Lambda. */
export interface HandlerRef {
  /** Project-relative path to the file declaring the class. */
  file: string;
  /** Class the method lives on. */
  className: string;
  /** Method name to invoke. */
  method: string;
  /** Source location for diagnostics. */
  source: SourceLocation;
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

/** @Cron('rate(...)') -> EventBridge schedule rule -> its own Lambda. */
export interface CronIR extends HandlerRef {
  /** Stable logical id, used for the CDK construct + function name. */
  id: string;
  /** EventBridge schedule expression, e.g. "rate(5 minutes)" or "cron(0 12 * * ? *)". */
  schedule: string;
}

/** @Queue({ name }) -> SQS queue -> its own consumer Lambda. */
export interface QueueIR extends HandlerRef {
  id: string;
  /** Queue name. A ".fifo" suffix or fifo:true marks a FIFO queue. */
  name: string;
  batchSize?: number;
  fifo?: boolean;
}

export interface InfraIR {
  app: {
    name: string;
    framework: Framework;
    /** Deployment stage; part of resource names. */
    stage: string;
    /** Project-relative app entry (same as http.handlerEntry). Absent for workers-only apps. */
    entry?: string;
  };
  /** Absent when HTTP is disabled (`http: false`) — a workers-only deployment. */
  http?: HttpIR;
  crons: CronIR[];
  queues: QueueIR[];
  /** Plain env injected into every Lambda. Secrets handling comes later. */
  env: Record<string, string>;
}
