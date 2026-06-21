/**
 * The wire contract between the laranja CLI and the laranja server.
 *
 * This module is TYPES ONLY (plus a couple of constants) — no runtime logic — so
 * it can be shared verbatim by the CLI and the backend and keep them in lockstep.
 *
 * Auth: every request carries the user's API key in an `x-api-key: <API_KEY>`
 * header. Project-scoped calls (e.g. `/synth`) also send the dashboard project
 * id in an `x-project-id: <projectId>` header. Neither is part of any body type
 * below — identity/context lives in headers, synth inputs in the body.
 *
 * Only the Infra IR crosses the wire — never the user's source code.
 */

import type { InfraIR } from "./ir.js";

export const API_VERSION = "v1";

/** Server mounts every route under this prefix (NestJS global prefix + version). */
export const API_PREFIX = `/api/${API_VERSION}`;

/** Shared endpoint paths, so both sides reference the same strings. */
export const ENDPOINTS = {
  /** GET — verify the API key + return tier/limits (used by `laranja init`). */
  me: `${API_PREFIX}/me`,
  /** POST — IR in, CloudFormation template (or CDK files) out. */
  synth: `${API_PREFIX}/synth`,
  /** POST — report a deploy/destroy outcome for the dashboard timeline. */
  deployments: `${API_PREFIX}/deployments`,
} as const;

/* -------------------------------------------------------------------------- */
/* Accounts / entitlements                                                    */
/* -------------------------------------------------------------------------- */

export type Tier = "free" | "pro" | "max";

/** What a tier is allowed to do. `-1` means unlimited. */
export interface Limits {
  maxProjects: number;
  deploysPerDay: number;
  /** Whether `artifact: "cdk"` (eject) is permitted. */
  canEject: boolean;
}

/** Response from `GET /v1/me` — lets `laranja init` validate the key + greet the user. */
export interface MeResponse {
  userId: string;
  displayName: string;
  projectId: string;
}

/* -------------------------------------------------------------------------- */
/* Synth                                                                      */
/* -------------------------------------------------------------------------- */

/** The artifact the client wants from `/synth`. `cdk` requires a paid tier. */
export type SynthArtifact = "cloudformation" | "cdk";

/** `POST /v1/synth` body. */
export interface SynthRequest {
  /** Project name/slug — scopes deployments + limit accounting on the server. */
  project: string;
  /** Deployment stage, e.g. "dev" / "prod". */
  stage: string;
  /** Which artifact to generate. */
  artifact: SynthArtifact;
  /** The Infra IR — structure only (routes, crons, queues, env, names). */
  ir: InfraIR;
}

/** A single generated file (used by the `cdk` artifact). */
export interface GeneratedFile {
  /** Path relative to the output dir, e.g. "lib/my-app-stack.ts". */
  path: string;
  contents: string;
}

interface SynthResponseBase {
  /** Opaque id linking this synth to the dashboard timeline; echo it to `/deployments`. */
  deploymentId: string;
}

/** Free + paid: the synthesized CloudFormation template the CLI then deploys. */
export interface CloudFormationSynthResponse extends SynthResponseBase {
  artifact: "cloudformation";
  stackName: string;
  /** CloudFormation template as JSON. */
  template: Record<string, unknown>;
}

/** Paid only: a standalone, editable CDK project (server-side eject). */
export interface CdkSynthResponse extends SynthResponseBase {
  artifact: "cdk";
  files: GeneratedFile[];
}

/** `200` response from `/synth` — discriminated on `artifact`. */
export type SynthResponse = CloudFormationSynthResponse | CdkSynthResponse;

/* -------------------------------------------------------------------------- */
/* Deployment reporting                                                       */
/* -------------------------------------------------------------------------- */

export type DeploymentStatus = "succeeded" | "failed" | "destroyed";

/**
 * A non-fatal issue surfaced during a deploy, reported for dashboard statistics
 * (e.g. "succeeded with 4 warnings"). Distinct from `status` — a deploy with
 * warnings still `succeeded`; we don't invent a third status.
 */
export type DeploymentWarningCode = "missing_env_value";

export interface DeploymentWarning {
  code: DeploymentWarningCode;
  /**
   * Affected identifiers for context — e.g. the env var NAMES that had no value.
   * NEVER values/secrets (the names already travel in the IR; values never do).
   */
  keys?: string[];
}

/** Kind of a deployed resource, for dashboard grouping/icons. ("function" = a plain compute fn — provider-neutral; was "lambda".) */
export type DeployedResourceKind = "http" | "cron" | "queue" | "function";

/**
 * A single deployed AWS resource, reported so the dashboard can show an
 * inventory + deep-link to the console (e.g. CloudWatch logs).
 *
 * SECURITY: identifiers ONLY — never env-var values or secrets. ARNs are not
 * credentials, but treat this as tenant-scoped data (per-user authz on read).
 */
export interface DeployedResource {
  kind: DeployedResourceKind;
  /** Physical resource name (Lambda function name, queue name, …). */
  name: string;
  /** Full ARN, for console deep-links. Reconstructable from account+region+name. */
  arn?: string;
  /** CloudWatch log group, for Lambda-backed resources. */
  logGroup?: string;
}

/** `POST /v1/deployments` body — the outcome of applying/destroying a synth. */
export interface DeploymentReport {
  /** From the `SynthResponse`. */
  deploymentId: string;
  status: DeploymentStatus;
  /** Where it was applied (for the dashboard). */
  account?: string;
  region?: string;
  /** CloudFormation outputs (HttpUrl, queue URLs, …) — shown as links. */
  outputs?: Record<string, string>;
  /** Inventory of deployed resources (names/ARNs only — no secret values). */
  resources?: DeployedResource[];
  /** Non-fatal issues surfaced during the deploy (e.g. unpopulated env vars). */
  warnings?: DeploymentWarning[];
  /** Populated when `status` is "failed". */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Error codes returned in the body alongside a non-2xx status:
 *   unauthorized   -> 401   (missing/invalid API key)
 *   forbidden      -> 403   (valid key, not entitled — e.g. cdk on free)
 *   limit_exceeded -> 402   (deploys/day or project cap hit)
 *   invalid_request-> 400   (malformed IR / payload)
 *   server_error   -> 500
 */
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "limit_exceeded"
  | "invalid_request"
  | "server_error";

export interface ApiError {
  error: ApiErrorCode;
  message: string;
  /** Where to upgrade, when relevant (limit_exceeded / forbidden). */
  upgradeUrl?: string;
  /** For rate limits: seconds until the client may retry. */
  retryAfter?: number;
}
