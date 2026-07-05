/**
 * Client-side resolution of the env var NAMES discovered in user code (the IR's
 * `envKeys`) against a source of values — by default the process environment.
 *
 * This runs on the developer's / CI machine at deploy time. The resolved VALUES
 * are injected into the Lambda's environment locally and never travel to the
 * server: only the names are in the IR (see `InfraIR.envKeys`).
 */

/** The outcome of resolving declared env names against a value source. */
export interface ResolvedEnv {
  /** name -> value, for every declared key that had a value. */
  resolved: Record<string, string>;
  /** Declared keys that had no value in the source (unset). */
  missing: string[];
}

/**
 * Resolve `envKeys` against `source` (defaults to `process.env`). A key is
 * "missing" only when it is unset (`undefined`); an explicit empty string is a
 * deliberate value and is kept.
 */
export function resolveDeclaredEnv(
  envKeys: string[],
  source: NodeJS.ProcessEnv = process.env,
): ResolvedEnv {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of envKeys) {
    const value = source[key];
    if (value === undefined) missing.push(key);
    else resolved[key] = value;
  }
  return { resolved, missing };
}

/**
 * The CloudFormation Parameter logical id for an env key. Each code-discovered
 * `env("NAME")` becomes a stack Parameter (so the value is supplied at deploy
 * time, never baked into the template). Logical ids must be alphanumeric, so
 * non-alphanumerics are stripped — this is the single source of truth shared by
 * the stack (which declares the Parameter) and the deploy step (which supplies
 * its value). Two keys that collide after stripping surface as a duplicate-id
 * error at synth, which is the desired loud failure.
 */
export function envParamName(key: string): string {
  return `Env${key.replace(/[^A-Za-z0-9]/g, "")}`;
}

/**
 * The Lambda environment variable name that carries a declared queue's SQS URL.
 * The synth injects `LARANJA_QUEUE_URL_<name>` into EVERY function's env (so any
 * function can produce to any queue), and the runtime producer — `getQueue(name)`
 * — reads the same key. This is the single source of truth shared by laranja-cdk
 * (which sets the value) and laranja-runtime (which reads it); keyed by the
 * queue's declared `name` (the user-facing identity), with non-alphanumerics
 * collapsed to "_" so it is a valid env-var name.
 */
export function queueUrlEnvName(name: string): string {
  return `LARANJA_QUEUE_URL_${name.replace(/[^A-Za-z0-9]/g, "_")}`;
}
