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
