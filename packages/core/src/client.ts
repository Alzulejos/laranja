/**
 * The laranja API client — the CLI's side of the wire contract in `api.ts`.
 *
 * Zero-dep: uses the global `fetch` (Node 18+). Only the Infra IR ever crosses
 * the wire (see `SynthRequest`); the user's source code never leaves the machine.
 */

import {
  ENDPOINTS,
  type MeResponse,
  type SynthRequest,
  type SynthResponse,
  type DiffResponse,
  type DeploymentPatch,
  type ResourcesReport,
  type DestroyRequest,
  type DestroyResponse,
  type ApiError,
  type ApiErrorCode,
} from "./api.js";
import { loadStoredApiKey } from "./auth.js";

/** Default server URL for local development. Override with `LARANJA_API_URL`. */
export const DEFAULT_API_URL = "http://localhost:3000";

/** Where to reach the server. Env override lets us point at prod later. */
export function resolveApiUrl(): string {
  return (process.env.LARANJA_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

/**
 * The caller's API key. Precedence: `LARANJA_API_KEY` env var (CI / one-off
 * override) wins, then the key persisted by `laranja init` (~/.laranja/auth.json).
 * The env override means a stored login never blocks a different key in CI.
 */
export function resolveApiKey(): string | undefined {
  return (process.env.LARANJA_API_KEY?.trim() || undefined) ?? loadStoredApiKey();
}

/** A failed API call — carries the server's error code so callers can branch. */
export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly upgradeUrl?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

interface RequestOptions {
  apiKey: string;
  /** Dashboard project id — sent as `x-project-id` (e.g. on `/synth`). */
  projectId?: string;
  /** Override the base URL (defaults to `resolveApiUrl()`). */
  baseUrl?: string;
  body?: unknown;
}

async function apiRequest<T>(method: "GET" | "POST" | "PATCH", endpoint: string, opts: RequestOptions): Promise<T> {
  const url = `${opts.baseUrl ?? resolveApiUrl()}${endpoint}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "x-api-key": opts.apiKey,
        ...(opts.projectId ? { "x-project-id": opts.projectId } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (cause) {
    throw new ApiRequestError("server_error", `Could not reach the laranja server at ${url}`, 0);
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => undefined)) as ApiError | undefined;
    throw new ApiRequestError(
      err?.error ?? "server_error",
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.upgradeUrl,
    );
  }

  return (await res.json()) as T;
}

/**
 * `GET /v1/me` — validate the API key and fetch the caller's tier/limits.
 * Used by `laranja init` to handshake with the server.
 */
export function getMe(apiKey: string, baseUrl?: string): Promise<MeResponse> {
  return apiRequest<MeResponse>("GET", ENDPOINTS.me, { apiKey, baseUrl });
}

/**
 * `POST /v1/synth` — send the Infra IR, get back a CloudFormation template
 * (or, for paid tiers, a CDK project). Only the IR crosses the wire; the
 * dashboard `projectId` rides in the `x-project-id` header.
 */
export function postSynth(
  req: SynthRequest,
  apiKey: string,
  projectId: string,
  baseUrl?: string,
): Promise<SynthResponse> {
  return apiRequest<SynthResponse>("POST", ENDPOINTS.synth, { apiKey, projectId, baseUrl, body: req });
}

/**
 * `POST /v1/diff` — a read-only synth: same input as `/synth`, returns a template
 * to diff against the deployed stack, but creates NO deployment row.
 */
export function postDiff(
  req: SynthRequest,
  apiKey: string,
  projectId: string,
  baseUrl?: string,
): Promise<DiffResponse> {
  return apiRequest<DiffResponse>("POST", ENDPOINTS.diff, { apiKey, projectId, baseUrl, body: req });
}

/**
 * `PATCH /v1/deployment/:id` — advance a deployment's status. Sent with
 * `{ status: "STARTED", region }` before touching AWS, then `{ status: "SUCCESS"
 * | "FAILED" }` once the deploy settles. The server resolves the project from
 * the API key, so the deployment id (in the URL) is the only context needed.
 */
export function patchDeployment(
  deploymentId: string,
  body: DeploymentPatch,
  apiKey: string,
  baseUrl?: string,
): Promise<boolean> {
  return apiRequest<boolean>("PATCH", ENDPOINTS.deployment(deploymentId), { apiKey, baseUrl, body });
}

/**
 * `POST /v1/deployment/:id/resources` — report the deployed inventory after a
 * successful deploy. Body is WRAPPED (`{ resources }`); a bare array 500s the BE.
 */
export function postDeploymentResources(
  deploymentId: string,
  body: ResourcesReport,
  apiKey: string,
  baseUrl?: string,
): Promise<boolean> {
  return apiRequest<boolean>("POST", ENDPOINTS.deploymentResources(deploymentId), { apiKey, baseUrl, body });
}

/**
 * `POST /v1/deployment/destory` — open a teardown deployment row and get its id,
 * so a destroy can drive the same status lifecycle (STARTED → SUCCESS/FAILED).
 * Tolerates either a `{ deploymentId }` body or a bare id string.
 */
export async function postDestroy(req: DestroyRequest, apiKey: string, baseUrl?: string): Promise<string> {
  const res = await apiRequest<DestroyResponse | string>("POST", ENDPOINTS.deploymentDestroy, { apiKey, baseUrl, body: req });
  return typeof res === "string" ? res : res.deploymentId;
}
