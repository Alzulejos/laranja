/**
 * Backing services an app declares it needs — a database, a cache — as opposed
 * to the compute laranja deploys (`http()`, `queue()`, `@Cron`).
 *
 * Provider-neutral by construction: a declaration says *what* the app needs, not
 * where it comes from. `laranja dev` renders these as local containers; managed
 * cloud provisioning renders the same declarations as RDS / Flexible Server /
 * ElastiCache later. One vocabulary, two back ends — so a project that runs
 * locally is already describing what it will need in the cloud.
 */

/** The service types laranja knows how to provision. */
export type ServiceKind = "postgres" | "redis";

/** Knobs shared by every service declaration. */
export interface ServiceOptions {
  /**
   * Environment variable the connection URL is published under, for the app to
   * read. Defaults to `serviceUrlEnvName(key)` — set this when the app already
   * expects a conventional name (`DATABASE_URL`, `REDIS_URL`) and you'd rather
   * not change the code to suit us.
   */
  env?: string;
}

/** A Postgres database. */
export interface PostgresService extends ServiceOptions {
  kind: "postgres";
  /** Major version. Defaults to 16. */
  version?: number;
}

/** A Redis-compatible cache. Locally this is Valkey. */
export interface RedisService extends ServiceOptions {
  kind: "redis";
  /** Major version. Defaults to 7. */
  version?: number;
}

export type ServiceDecl = PostgresService | RedisService;

/**
 * Declared services, keyed by a name of the user's choosing. The key is the
 * service's identity everywhere else — the env var it publishes, its container
 * name, its entry in `.laranja/dev.json` — so it must be stable; renaming a key
 * is renaming the service.
 */
export type ServicesConfig = Record<string, ServiceDecl>;

/** Declare a Postgres database. `services: { db: postgres() }` */
export function postgres(options: Omit<PostgresService, "kind"> = {}): PostgresService {
  return { kind: "postgres", ...options };
}

/** Declare a Redis-compatible cache. `services: { cache: redis() }` */
export function redis(options: Omit<RedisService, "kind"> = {}): RedisService {
  return { kind: "redis", ...options };
}

/**
 * The env var a service publishes its connection URL under, when the
 * declaration doesn't override it with `env`.
 *
 * Mirrors `queueUrlEnvName`'s shape and rules — same prefix convention,
 * non-alphanumerics collapsed to "_", upper-cased — so the two families of
 * injected variables read as one system. Single source of truth: `dev` writes
 * the value and the app reads this name.
 */
export function serviceUrlEnvName(key: string): string {
  return `LARANJA_SERVICE_URL_${key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

/** The env var name a declared service actually publishes under. */
export function resolveServiceEnvName(key: string, service: ServiceDecl): string {
  return service.env ?? serviceUrlEnvName(key);
}

/**
 * Redis logical database indexes. The cache the user declared lives on 0; local
 * queues live on 1.
 *
 * They MUST NOT share an index: a `FLUSHDB` in application code — routine when
 * clearing a cache — would otherwise silently delete every queued message, with
 * no error and nothing in the logs to explain the loss.
 */
export const REDIS_DB_CACHE = 0;
export const REDIS_DB_QUEUE = 1;
