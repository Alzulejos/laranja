/**
 * The laranja API client — the CLI's side of the wire contract in `api.ts`.
 *
 * Zero-dep: uses the global `fetch` (Node 18+). Only the Infra IR ever crosses
 * the wire (see `SynthRequest`); the user's source code never leaves the machine.
 */

import {
  ENDPOINTS,
  type MeResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type SynthRequest,
  type SynthResponse,
  type DiffResponse,
  type EjectResponse,
  type DeploymentPatch,
  type ResourcesReport,
  type DestroyRequest,
  type DestroyResponse,
  type DeploymentFailureReport,
  type ApiError,
  type ApiErrorCode,
} from "./api.js";
import { createRequire } from "node:module";
import { loadStoredApiKey } from "./auth.js";
import { CONFIG_FILENAME } from "./config.js";

/**
 * The installed CLI version, sent as `x-cli-version` on every API request so the
 * server can identify (and, in future, reject) unsupported clients. Sourced from
 * this package's own `package.json` — core + cli are version-locked in lockstep
 * by `scripts/set-version.mjs`, so core's version *is* the CLI version. Resolves
 * in both dev (`src/`) and the published build (`dist/`) since `../package.json`
 * is the package root either way (core is plain `tsc`, 1:1 src→dist).
 */
export const CLI_VERSION: string = (() => {
  try {
    const req = createRequire(import.meta.url);
    return (req("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

/** Default server URL for local development. Override with `LARANJA_API_URL`. */
export const DEFAULT_API_URL = "https://api.laranja.io";

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
  return (
    (process.env.LARANJA_API_KEY?.trim() || undefined) ?? loadStoredApiKey()
  );
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

/** Base URL of the laranja dashboard web app. Override with `LARANJA_DASHBOARD_URL` for local dev. */
export const DASHBOARD_URL = (process.env.LARANJA_DASHBOARD_URL ?? "https://laranja.io/app").replace(/\/+$/, "");

/** Dashboard page where users create / manage their API keys. */
export const DASHBOARD_KEYS_URL = `${DASHBOARD_URL}/user`;

/**
 * True when an error means the API key itself is the problem — missing,
 * expired, or deleted — as opposed to an entitlement issue.
 *
 * The server is inconsistent about how it reports a bad key (it leans on
 * NestJS's generic exceptions rather than our structured `ApiErrorCode`):
 *   - a proper `401`,
 *   - a `400 { error: "Bad Request", message: "Invalid API KEY" }`,
 *   - a `403 { error: "Forbidden", message: "Forbidden resource" }` when an
 *     expired/deleted key trips the auth guard.
 * So we treat any 401/403, or a message of "Invalid API KEY", as a bad key.
 *
 * The one 403 that is NOT a key problem is a *real* entitlement failure ("valid
 * key, not entitled"), which uses our structured contract: lower-case `code:
 * "forbidden"` + an `upgradeUrl`. NestJS's generic guard rejection instead puts
 * capital-`F` `"Forbidden"` in the body's `error` field, so the two don't
 * collide — we exclude only the lower-case structured code.
 */
export function isAuthKeyError(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false;
  if (err.code === "forbidden") return false; // structured entitlement, not a bad key
  if (err.code === "project_access") return false; // valid key, project-access issue
  return (
    err.status === 401 ||
    err.status === 403 ||
    /invalid\s+api\s+key/i.test(err.message)
  );
}

/**
 * Turn an `ApiRequestError` into a friendly, actionable one-or-many-line
 * message, prefixed with the failing step (e.g. "Handshake failed"). Bad-key
 * errors get create-a-new-key guidance; an unreachable server gets a "is it
 * running?" hint; everything else falls back to the server's own message.
 */
export function apiErrorMessage(prefix: string, err: ApiRequestError): string {
  if (isAuthKeyError(err)) {
    return [
      `${prefix} — your API key is invalid, expired, or was deleted.`,
      "",
      `  Create a new key at ${DASHBOARD_KEYS_URL}, then export it:`,
      "      export LARANJA_API_KEY=<NEW_KEY>",
      "",
      "  (laranja also reads a saved key from ~/.laranja/auth.json —",
      "   a stale one there can cause this too.)",
    ].join("\n");
  }
  if (err.code === "project_access") {
    return [
      `${prefix} — you don't have access to this project.`,
      "",
      "  Your API key is fine, but the project it's pointing at isn't reachable.",
      "  This usually means one of:",
      "    • the project was deleted from your dashboard,",
      "    • you were removed from it, or",
      `    • the "projectId" in ${CONFIG_FILENAME} is wrong.`,
      "",
      `  Check your projects at ${DASHBOARD_URL} and update "projectId" in ${CONFIG_FILENAME}.`,
    ].join("\n");
  }
  const hint =
    err.status === 0
      ? `is the server running at ${resolveApiUrl()}?`
      : err.message;
  return `${prefix} — ${hint}`;
}

interface RequestOptions {
  apiKey: string;
  /** Dashboard project id — sent as `x-project-id` (e.g. on `/synth`). */
  projectId?: string;
  /** Override the base URL (defaults to `resolveApiUrl()`). */
  baseUrl?: string;
  body?: unknown;
}

async function apiRequest<T>(
  method: "GET" | "POST" | "PATCH",
  endpoint: string,
  opts: RequestOptions,
): Promise<T> {
  const url = `${opts.baseUrl ?? resolveApiUrl()}${endpoint}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "x-api-key": opts.apiKey,
        "x-cli-version": CLI_VERSION,
        ...(opts.projectId ? { "x-project-id": opts.projectId } : {}),
        ...(opts.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (cause) {
    throw new ApiRequestError(
      "server_error",
      `Could not reach the laranja server at ${url}`,
      0,
    );
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => undefined)) as
      | ApiError
      | undefined;
    throw new ApiRequestError(
      err?.error ?? "server_error",
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.upgradeUrl,
    );
  }

  // Read defensively: some endpoints return a bare (unquoted) id string — e.g.
  // destroy — or an empty body, neither of which `res.json()` can parse.
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * `GET /v1/me` — validate the API key and fetch the caller's tier/limits.
 * Used by `laranja init` to handshake with the server.
 */
export function getMe(apiKey: string, baseUrl?: string): Promise<MeResponse> {
  return apiRequest<MeResponse>("GET", ENDPOINTS.me, { apiKey, baseUrl });
}

/**
 * `POST /v1/project` — create a project (name only) from the CLI and get back
 * its server id. User-scoped: authed by the API key, no `x-project-id`.
 */
export function createProject(
  name: string,
  apiKey: string,
  baseUrl?: string,
): Promise<CreateProjectResponse> {
  const body: CreateProjectRequest = { name };
  return apiRequest<CreateProjectResponse>("POST", ENDPOINTS.project, {
    apiKey,
    baseUrl,
    body,
  });
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
  return apiRequest<SynthResponse>("POST", ENDPOINTS.synth, {
    apiKey,
    projectId,
    baseUrl,
    body: req,
  });
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
  return apiRequest<DiffResponse>("POST", ENDPOINTS.diff, {
    apiKey,
    projectId,
    baseUrl,
    body: req,
  });
}

/**
 * `POST /v1/eject` — generate a standalone, owned CDK project from the IR. The
 * server gates this on the caller's entitlement (403 if not allowed). Nothing is
 * persisted; the client writes the returned files to disk.
 */
export function postEject(
  req: SynthRequest,
  apiKey: string,
  projectId: string,
  baseUrl?: string,
): Promise<EjectResponse> {
  return apiRequest<EjectResponse>("POST", ENDPOINTS.eject, {
    apiKey,
    projectId,
    baseUrl,
    body: req,
  });
}

/**
 * `POST /v1/report` — send a structured CLI failure report, scoped to the user
 * (api key) + project (project id). Diagnostics only. See `DeploymentFailureReport`.
 */
export function postReport(
  report: DeploymentFailureReport,
  apiKey: string,
  projectId: string,
  baseUrl?: string,
): Promise<unknown> {
  return apiRequest<unknown>("POST", ENDPOINTS.report, {
    apiKey,
    projectId,
    baseUrl,
    body: report,
  });
}

/**
 * `PATCH /v1/deployment/:id` — advance a deployment's status. Sent with
 * `{ status: "STARTED", region }` before touching AWS, then `{ status: "SUCCESS"
 * | "FAILED" }` once the deploy settles. The dashboard `projectId` rides in the
 * `x-project-id` header, consistent with the rest of the deploy/destroy calls.
 */
export function patchDeployment(
  deploymentId: string,
  body: DeploymentPatch,
  apiKey: string,
  projectId: string,
  baseUrl?: string,
): Promise<boolean> {
  return apiRequest<boolean>("PATCH", ENDPOINTS.deployment(deploymentId), {
    apiKey,
    projectId,
    baseUrl,
    body,
  });
}

/**
 * `POST /v1/deployment/:id/resources` — report the deployed inventory after a
 * successful deploy. Body is WRAPPED (`{ resources }`); a bare array 500s the BE.
 */
export function postDeploymentResources(
  deploymentId: string,
  body: ResourcesReport,
  apiKey: string,
  projectId: string,
  baseUrl?: string,
): Promise<boolean> {
  return apiRequest<boolean>(
    "POST",
    ENDPOINTS.deploymentResources(deploymentId),
    { apiKey, projectId, baseUrl, body },
  );
}

/**
 * `POST /v1/deployment/destory` — open a teardown deployment row and get its id,
 * so a destroy can drive the same status lifecycle (STARTED → SUCCESS/FAILED).
 * Tolerates either a `{ deploymentId }` body or a bare id string.
 */
export async function postDestroy(
  req: DestroyRequest,
  apiKey: string,
  projectId: string,
  baseUrl?: string,
): Promise<string> {
  const res = await apiRequest<DestroyResponse | string>(
    "POST",
    ENDPOINTS.deploymentDestroy,
    { apiKey, projectId, baseUrl, body: req },
  );
  return typeof res === "string" ? res : res.deploymentId;
}
