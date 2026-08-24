import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ServiceDecl, ServiceKind } from "@alzulejos/laranja-core";

/** Where per-project dev state lives, relative to the project directory. */
export const DEV_DIR = ".laranja/dev";
export const DEV_STATE_FILE = ".laranja/dev.json";
export const DEV_ENV_FILE = ".laranja/dev.env";

/** One provisioned service, as recorded in `.laranja/dev.json`. */
export interface DevServiceState {
  kind: ServiceKind;
  /** Docker container name — derived, but stored so `down` works without the config. */
  container: string;
  /** Host port. Allocated once (see `allocatePort`) and then never changes. */
  port: number;
  /** Docker volume name holding the data. */
  volume: string;
}

export interface DevState {
  /** Dashboard project id this state belongs to — guards against a copied file. */
  projectId: string;
  createdAt: string;
  services: Record<string, DevServiceState>;
}

export function devStatePath(projectDir: string): string {
  return path.join(projectDir, DEV_STATE_FILE);
}

export function readDevState(projectDir: string): DevState | undefined {
  const file = devStatePath(projectDir);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DevState;
  } catch {
    // A corrupt state file must not wedge the command: every value in it is
    // either derivable (credentials) or re-allocatable (ports), so the safe move
    // is to treat it as absent and rebuild.
    return undefined;
  }
}

export function writeDevState(projectDir: string, state: DevState): void {
  const file = devStatePath(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Deterministic credentials for a local service.
 *
 * DERIVED, never random. `.laranja/dev.json` is gitignored and disposable, and a
 * user will delete it — so if the password lived only in that file, losing it
 * would orphan the Docker volume holding their data with no way back in.
 * Deriving from (project id, service key) means `dev status` can always recompute
 * the same credentials and they still open the existing volume.
 *
 * Not a secret: this only ever guards a container bound to localhost.
 */
export function deriveSecret(projectId: string, key: string, purpose: string): string {
  return createHash("sha256").update(`${projectId}:${key}:${purpose}`).digest("hex").slice(0, 24);
}

/** The database name for a Postgres service — stable and readable. */
export function deriveDbName(key: string): string {
  return `laranja_${key.replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}`;
}

/** Container name for a service. Namespaced by project so two projects can both run. */
export function containerName(projectName: string, key: string): string {
  return `laranja-${slug(projectName)}-${slug(key)}`;
}

/** Volume name for a service. Matches the container name so `dev reset` is obvious. */
export function volumeName(projectName: string, key: string): string {
  return `${containerName(projectName, key)}-data`;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
}

/** The port a service would prefer, before collision handling. */
export function defaultPort(kind: ServiceKind): number {
  return kind === "postgres" ? 5432 : 6379;
}

/**
 * Find a free host port at or above `from`, skipping any already handed out in
 * this same run (`taken`) — those aren't bound yet, so probing alone would hand
 * out the same port twice.
 *
 * Ports are allocated once and then persisted, because a developer will have
 * several laranja projects on one machine and a port that moves between runs
 * breaks every `.env`, GUI profile and shell alias pointing at it.
 */
export async function allocatePort(from: number, taken: Set<number>): Promise<number> {
  for (let port = from; port < from + 200; port++) {
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port found near ${from}.`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** The connection URL published to the app for one provisioned service. */
export function connectionUrl(
  projectId: string,
  key: string,
  service: ServiceDecl,
  state: DevServiceState,
): string {
  if (service.kind === "postgres") {
    const user = "laranja";
    const password = deriveSecret(projectId, key, "password");
    return `postgres://${user}:${password}@localhost:${state.port}/${deriveDbName(key)}`;
  }
  // Redis: no auth locally. Db 0 is the user's cache — queues live on db 1 and
  // are addressed by the runtime, never by the app.
  return `redis://localhost:${state.port}/0`;
}
