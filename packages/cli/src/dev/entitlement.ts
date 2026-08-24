import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { authDir, getMe } from "@alzulejos/laranja-core";
import * as ui from "../ui.js";

/** How long a successful account check is trusted before we ask again. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedEntitlement {
  /** Hash of the API key, so a rotated key re-checks and no key is stored here. */
  keyHash: string;
  checkedAt: number;
  userId: string;
}

function cachePath(): string {
  return path.join(authDir(), "dev-entitlement.json");
}

function hashKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
}

function readCache(): CachedEntitlement | undefined {
  const file = cachePath();
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CachedEntitlement;
  } catch {
    return undefined;
  }
}

function writeCache(entry: CachedEntitlement): void {
  mkdirSync(authDir(), { recursive: true });
  writeFileSync(cachePath(), `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Confirm the API key belongs to a real account.
 *
 * This is an ENTITLEMENT check, not an authorization one: `dev` provisions
 * containers on the developer's own machine, so there is nothing to scope — no
 * deploy permission, no project capability, no region. Having an account is the
 * whole requirement.
 *
 * Cached for a week, and a cached result is honoured when the API is
 * unreachable. A local dev environment that stops working on a plane, or during
 * an outage of ours, is worse than no local dev environment — and since the
 * check gates nothing that costs us money, failing open is the correct trade.
 */
export async function checkEntitlement(apiKey: string): Promise<boolean> {
  const keyHash = hashKey(apiKey);
  const cached = readCache();
  const fresh = cached && cached.keyHash === keyHash && Date.now() - cached.checkedAt < TTL_MS;
  if (fresh) return true;

  try {
    const me = await getMe(apiKey);
    writeCache({ keyHash, checkedAt: Date.now(), userId: me.userId });
    return true;
  } catch (err) {
    // A previously-valid check for THIS key means the account exists; only the
    // network is in doubt. Proceed, and say so rather than failing silently.
    if (cached?.keyHash === keyHash) {
      ui.warn("Could not reach laranja — continuing with your cached account check.");
      return true;
    }
    ui.warn(`Could not verify your laranja account: ${(err as Error).message}`);
    return false;
  }
}
