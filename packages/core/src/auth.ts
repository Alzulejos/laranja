/**
 * Global, user-level credential store for the laranja CLI.
 *
 * The API key is account-scoped (the same key works for every project), so it
 * lives once in the user's home dir — NOT in the committed `laranja.config.ts`.
 * This is the Vercel-style "log in once" model: `laranja init` validates the
 * key against `/me` and then persists it here, so later commands don't need
 * `LARANJA_API_KEY` re-exported in every shell.
 *
 * Layout (cross-platform via `os.homedir()`):
 *   ~/.laranja/auth.json        (file mode 0600, dir mode 0700 where supported)
 *   { "apiKey": "...", "apiUrl": "..." }
 */

import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";

/** Directory holding laranja's user-level state. Override with `LARANJA_HOME`. */
export function authDir(): string {
  return process.env.LARANJA_HOME?.trim() || path.join(os.homedir(), ".laranja");
}

/** Path to the credential file. */
export function authFilePath(): string {
  return path.join(authDir(), "auth.json");
}

/** On-disk shape of the credential file. */
export interface StoredAuth {
  apiKey: string;
  /** The API URL the key was validated against — informational. */
  apiUrl?: string;
}

/** Read the stored credentials, or `undefined` if none / unreadable. */
export function loadStoredAuth(): StoredAuth | undefined {
  const file = authFilePath();
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredAuth>;
    const apiKey = data.apiKey?.trim();
    if (!apiKey) return undefined;
    return { apiKey, apiUrl: data.apiUrl };
  } catch {
    // Corrupt file — treat as "not logged in" rather than crashing the CLI.
    return undefined;
  }
}

/** Convenience: just the stored key, if any. */
export function loadStoredApiKey(): string | undefined {
  return loadStoredAuth()?.apiKey;
}

/**
 * Persist credentials to `~/.laranja/auth.json` with owner-only permissions.
 * Creates the directory if needed. Returns the path written.
 */
export function storeAuth(auth: StoredAuth): string {
  const dir = authDir();
  // `recursive: true` makes mkdir a no-op if the dir already exists.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = authFilePath();
  writeFileSync(file, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  // mkdir/writeFile honor `mode` only on creation; enforce it explicitly so an
  // existing, looser file is tightened. (On Windows chmod is a best-effort
  // no-op — POSIX perms don't apply there; the file lives in the user profile.)
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permissions */
  }
  return file;
}

/**
 * Delete the stored credentials (`laranja logout`). Returns `true` if a file
 * was removed, `false` if there was nothing stored.
 */
export function clearAuth(): boolean {
  const file = authFilePath();
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}
