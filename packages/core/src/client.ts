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

async function apiRequest<T>(method: "GET" | "POST", endpoint: string, opts: RequestOptions): Promise<T> {
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
