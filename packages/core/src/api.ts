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

/**
 * Shared endpoint paths, so both sides reference the same strings.
 *
 * Deployment reporting is a lifecycle, not a single call: `/synth` opens a
 * deployment row (`INITIATED`), then the client PATCHes status as it deploys
 * (`STARTED` → `SUCCESS`/`FAILED`) and POSTs the resource inventory on success.
 * The `:id` here is the `deploymentId` returned by `/synth`.
 */
export const ENDPOINTS = {
  /** GET — verify the API key + return tier/limits (used by `laranja init`). */
  me: `${API_PREFIX}/me`,
  /** POST — IR in, CloudFormation template (or CDK files) out; opens the deployment row. */
  synth: `${API_PREFIX}/synth`,
  /** PATCH — advance a deployment's status (STARTED before AWS, then SUCCESS/FAILED). */
  deployment: (id: string) => `${API_PREFIX}/deployment/${id}`,
  /** POST — report the deployed resource inventory (success only). */
  deploymentResources: (id: string) => `${API_PREFIX}/deployment/${id}/resources`,
  /** POST — open a teardown deployment row (destroy has no `/synth`). */
  deploymentDestroy: `${API_PREFIX}/deployment/destory`,
  /** POST — read-only synth (returns a template, creates NO deployment row). */
  diff: `${API_PREFIX}/diff`,
  /** POST — generate a standalone, owned CDK project (paid; server-gated). */
  eject: `${API_PREFIX}/eject`,
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

/**
 * Per-handler content hash of the client-built zip, keyed by handler id
 * ("http" | cron.id | queue.id). The hash is CDK's own `Asset.assetHash`
 * (a SOURCE fingerprint), computed client-side at bundle time. The server
 * embeds it into the template as the bootstrap-bucket object key (`<hash>.zip`)
 * so the Lambda code reference lines up with where the client's toolkit later
 * uploads the matching zip. Only the hash crosses the wire — never the code.
 */
export type HandlerAssetHashes = Record<string, string>;

/**
 * What `/synth` reports back per handler so the client can publish its zip to
 * the exact key the template references.
 */
export interface HandlerAsset {
  /** Handler id — matches the client's bundled-zip id ("http" | cron.id | queue.id). */
  id: string;
  /** Short label (e.g. "app", or the cron/queue method name). */
  label: string;
  /** Content hash supplied for this handler. */
  hash: string;
  /** S3 object key the template references (in the bootstrap assets bucket). */
  s3Key: string;
}

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
  /** Content hash per handler id, so the template's S3 keys match the client's uploads. */
  assets: HandlerAssetHashes;
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
  /** Per-handler asset map (hash → S3 key) the client uploads its zips against. */
  assets: HandlerAsset[];
}

/** Paid only: a standalone, editable CDK project (server-side eject). */
export interface CdkSynthResponse extends SynthResponseBase {
  artifact: "cdk";
  files: GeneratedFile[];
}

/**
 * `200` response from `/eject` — the generated standalone CDK project. Like the
 * `cdk` synth response but with NO `deploymentId` (nothing is persisted). The
 * server gates this on the caller's `canEject` entitlement (403 otherwise).
 */
export interface EjectResponse {
  files: GeneratedFile[];
}

/** `200` response from `/synth` — discriminated on `artifact`. */
export type SynthResponse = CloudFormationSynthResponse | CdkSynthResponse;

/**
 * `200` response from `/diff` — a read-only synth. Same fields as the
 * CloudFormation synth response but with NO `deploymentId` (nothing is
 * persisted). Fields are optional to mirror the server's `Partial<SynthResponse>`.
 */
export type DiffResponse = Partial<Pick<CloudFormationSynthResponse, "stackName" | "template" | "assets">>;

/* -------------------------------------------------------------------------- */
/* Deployment reporting (lifecycle)                                           */
/* -------------------------------------------------------------------------- */

/**
 * A deployment moves through these states. The SERVER owns `INITIATED` (set when
 * `/synth` opens the row); the CLIENT drives the rest via PATCH. Anything stuck
 * in `INITIATED`/`STARTED` past a TTL is treated as abandoned by the server.
 */
export type DeploymentStatus = "INITIATED" | "STARTED" | "SUCCESS" | "FAILED";

/**
 * `PATCH /v1/deployment/:id` body sent right after `/synth`, BEFORE touching AWS.
 * `region` travels ONLY on this transition (it's where the deploy will land).
 */
export interface DeploymentStartedPatch {
  status: "STARTED";
  region: string;
}

/**
 * `PATCH /v1/deployment/:id` body sent after the AWS deploy settles. No region.
 * The success handler must be idempotent (a retried PATCH must not error).
 */
export interface DeploymentOutcomePatch {
  status: "SUCCESS" | "FAILED";
}

/** Every client-driven status PATCH body, discriminated on `status`. */
export type DeploymentPatch = DeploymentStartedPatch | DeploymentOutcomePatch;

/**
 * Logical resource kind, for dashboard grouping/icons. ("function" = a plain
 * compute fn — provider-neutral.) For an `http` proxy the logical name is "http".
 */
export type DeployedResourceType = "http" | "cron" | "queue" | "function";

/**
 * How a resource changed in this deploy, derived from the CloudFormation change
 * set (Add → CREATED, Modify → UPDATED, Remove → REMOVED). Computed against live
 * AWS state so reports self-heal if one is ever missed.
 */
export type DeployedResourceAction = "CREATED" | "REMOVED" | "UPDATED";

/**
 * Free-form, kind-specific config bag stored on each resource (BE column is
 * jsonb). Open by design — extra keys are allowed — but two are conventional:
 * `warnings` for non-fatal per-resource issues (env names only, no values).
 */
export interface ResourceMetadata {
  /** Non-fatal issues affecting this resource — e.g. unpopulated env-var NAMES. */
  warnings?: string[];
  [key: string]: unknown;
}

/**
 * One LOGICAL laranja resource (not one physical AWS resource) in the deployed
 * inventory, reported so the dashboard can show an inventory + deep-link to the
 * console.
 *
 * SECURITY: identifiers ONLY — never env-var values or secrets. ARNs/URLs are
 * not credentials, but treat this as tenant-scoped data (per-user authz on read).
 */
export interface DeployedResource {
  /** Logical id, e.g. "cleanup", "process-order", or "http" for the proxy. */
  name: string;
  type: DeployedResourceType;
  action: DeployedResourceAction;
  /**
   * Kind-specific config (cron schedule, queue name/fifo/batchSize, lambda cfg).
   * MUST be `{}` when there's nothing to report — never `null`. No routes.
   *
   * May also carry `warnings: string[]` — non-fatal issues affecting THIS
   * resource, e.g. the NAMES of env vars that had no value at deploy time. Names
   * only, never values/secrets. (BE stores `metadata` as jsonb, so no schema
   * change is needed to add this.)
   */
  metadata: ResourceMetadata;
  /** Primary Lambda function ARN. `null` for REMOVED if unknown. */
  externalId: string | null;
  /** For `http`, the Lambda Function URL (no API Gateway). `null` for cron/queue. */
  externalUrl: string | null;
}

/**
 * `POST /v1/deployment/:id/resources` body — the deployed inventory, sent on
 * SUCCESS only. WRAPPED in an object (a bare array 500s the BE controller).
 */
export interface ResourcesReport {
  resources: DeployedResource[];
}

/**
 * `POST /v1/deployment/destory` body — opens a teardown deployment row. A destroy
 * never hits `/synth` (nothing to synthesize), so this is how it gets a row + id.
 * The project comes from the API key; the body identifies the stack being torn
 * down. The BE owns the REMOVED resource inventory (from the last deployment).
 */
export interface DestroyRequest {
  /** Physical stack name, e.g. "myapp-dev". */
  stackName: string;
  artifact: SynthArtifact;
  /** Target cloud, e.g. "AWS". */
  provider: string;
  region: string;
}

/** `POST /v1/deployment/destory` response — the new teardown row's id. */
export interface DestroyResponse {
  deploymentId: string;
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
