import path from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import {
  loadConfig,
  resolveApiKey,
  resolveServiceEnvName,
  redis as redisService,
  PROVIDER_ENV_NAME,
  REDIS_DB_QUEUE,
  type ServicesConfig,
} from "@alzulejos/laranja-core";
import { scan } from "@alzulejos/laranja-scanner";
import { checkEntitlement } from "../dev/entitlement.js";
import { composeDown, composeProject, composeUp, probeDocker, waitHealthy } from "../dev/docker.js";
import { renderCompose } from "../dev/compose.js";
import {
  DEV_DIR,
  DEV_ENV_FILE,
  allocatePort,
  connectionUrl,
  containerName,
  defaultPort,
  devStatePath,
  readDevState,
  volumeName,
  writeDevState,
  type DevServiceState,
  type DevState,
} from "../dev/state.js";
import { confirm } from "../io.js";
import * as ui from "../ui.js";

export type DevAction = "up" | "status" | "down" | "reset";

/**
 * Key used for the Redis we start on a project's behalf when it has queues but
 * declared no cache of its own.
 */
const IMPLICIT_CACHE_KEY = "queue";

export async function dev(
  projectDir: string,
  action: DevAction = "up",
  opts: { stage?: string } = {},
): Promise<void> {
  const config = await loadConfig(projectDir, { stage: opts.stage });
  const projectId = config.projectId ?? config.name;
  const project = composeProject(config.name);
  const composeFile = path.join(projectDir, DEV_DIR, "docker-compose.yml");

  // Stopping must not depend on the project still parsing — a half-finished
  // refactor is exactly when someone reaches for `dev down`.
  if (action === "down" || action === "reset") {
    return teardown(projectDir, composeFile, project, action);
  }

  // Syntax-only AST scan: no build, no node_modules. Tells us both which
  // services the project needs and whether it has handlers to run locally.
  const ir = scan({ projectDir, config });
  const services = resolveServices(config, ir.queues.length > 0);

  if (action === "status") return status(projectDir, projectId, services);

  if (Object.keys(services).length === 0) {
    ui.note("No services declared. Add e.g. `services: { db: postgres() }` to laranja.config.ts.");
    return;
  }

  // Account check before touching Docker: nothing below is expensive, but a
  // failed check should not leave half a stack running.
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error("Set LARANJA_API_KEY (or run `laranja init`) to use `laranja dev`.");
  }
  if (!(await checkEntitlement(apiKey))) return;

  const docker = await probeDocker();
  if (!docker.ok) throw new Error(docker.reason);

  ui.header(`dev ${config.name}`);

  const state = await ensureState(projectDir, projectId, config.name, services);

  mkdirSync(path.join(projectDir, DEV_DIR), { recursive: true });
  writeFileSync(composeFile, renderCompose(projectId, services, state.services));

  const spin = ui.spinner("starting services");
  try {
    await composeUp(composeFile, project);
    const unhealthy = await waitHealthy(Object.values(state.services).map((s) => s.container));
    spin.stop();
    if (unhealthy.length > 0) {
      ui.warn(`Not healthy yet: ${unhealthy.join(", ")}. Check \`docker logs <name>\`.`);
    }
  } catch (err) {
    spin.stop();
    throw err;
  }

  const env = buildEnv(projectId, services, state.services);
  writeEnvFile(projectDir, env);
  printTable(projectId, services, state.services);

  ui.note(`Wrote ${DEV_ENV_FILE} — load it from your app (dotenv, or \`source\`), then start it as you normally would.`);

  // Crons and queue consumers run inside the user's process — we don't start
  // their app — so they need the one call that turns them on. It no-ops when
  // LARANJA_PROVIDER isn't "local", which is why it is safe to commit.
  if (ir.crons.length > 0 || ir.queues.length > 0) {
    const what = [
      ir.crons.length > 0 ? `${ir.crons.length} cron(s)` : "",
      ir.queues.length > 0 ? `${ir.queues.length} queue(s)` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    ui.note(`Found ${what}. To run them locally, call startLocal() where your app boots:`);
    console.log(ui.dim("    import { startLocal } from \"@alzulejos/laranja-runtime\";"));
    console.log(ui.dim("    await startLocal({ app }); // `app` only needed for Nest"));
  }
}

/**
 * Declared services, plus a Redis when the project has queues but declared no
 * cache.
 *
 * Local queues are backed by Redis, so a project with a `queue()` needs one
 * whether or not it asked for a cache. Starting it implicitly keeps the user
 * from having to understand our storage choice in order to run their own code —
 * the connection table labels it as queue infrastructure rather than passing it
 * off as their cache.
 */
function resolveServices(
  config: Awaited<ReturnType<typeof loadConfig>>,
  hasQueues: boolean,
): ServicesConfig {
  const declared: ServicesConfig = { ...(config.services ?? {}) };
  const hasCache = Object.values(declared).some((s) => s.kind === "redis");
  if (hasCache || !hasQueues) return declared;
  return { ...declared, [IMPLICIT_CACHE_KEY]: redisService() };
}

/**
 * Load state, adding entries for services that don't have one yet.
 *
 * Existing entries are never rewritten: the port in particular must stay put
 * across runs, because the developer has by then pasted it into `.env` files,
 * database GUIs and shell history.
 */
async function ensureState(
  projectDir: string,
  projectId: string,
  projectName: string,
  services: ServicesConfig,
): Promise<DevState> {
  const existing = readDevState(projectDir);
  const state: DevState = {
    projectId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    services: { ...(existing?.projectId === projectId ? existing.services : {}) },
  };

  const taken = new Set(Object.values(state.services).map((s) => s.port));
  for (const [key, service] of Object.entries(services)) {
    if (state.services[key]?.kind === service.kind) continue;
    const port = await allocatePort(defaultPort(service.kind), taken);
    taken.add(port);
    state.services[key] = {
      kind: service.kind,
      container: containerName(projectName, key),
      port,
      volume: volumeName(projectName, key),
    };
  }

  // Drop state for services no longer declared, so the file doesn't accumulate
  // ghosts that `status` would print and `down` would look for.
  for (const key of Object.keys(state.services)) {
    if (!services[key]) delete state.services[key];
  }

  writeDevState(projectDir, state);
  return state;
}

/** The env every declared service publishes, plus the local-provider marker. */
function buildEnv(
  projectId: string,
  services: ServicesConfig,
  state: Record<string, DevServiceState>,
): Record<string, string> {
  const env: Record<string, string> = {
    // Tells the runtime's producer and consumer to take the local path instead
    // of SQS or Azure Storage Queues. Same switch the back-halves set at deploy.
    [PROVIDER_ENV_NAME]: "local",
  };
  for (const [key, service] of Object.entries(services)) {
    const s = state[key];
    if (!s) continue;
    env[resolveServiceEnvName(key, service)] = connectionUrl(projectId, key, service, s);
    if (service.kind === "redis") {
      // Where the local queue implementation puts its messages: the same Redis,
      // a different logical database, so a `FLUSHDB` against the cache can't
      // take the queues with it.
      env.LARANJA_QUEUE_REDIS_URL = connectionUrl(projectId, key, service, s).replace(
        /\/\d+$/,
        `/${REDIS_DB_QUEUE}`,
      );
    }
  }
  return env;
}

function writeEnvFile(projectDir: string, env: Record<string, string>): void {
  const file = path.join(projectDir, DEV_ENV_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const body = [
    "# Generated by `laranja dev`. Overwritten on every run — do not edit.",
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
  writeFileSync(file, body);
}

/** The connection table. This is the product of the command, not log output. */
function printTable(
  projectId: string,
  services: ServicesConfig,
  state: Record<string, DevServiceState>,
): void {
  console.log("");
  const width = Math.max(...Object.keys(services).map((k) => k.length), 8);
  for (const [key, service] of Object.entries(services)) {
    const s = state[key];
    if (!s) continue;
    const label = key.toUpperCase().padEnd(width);
    const url = connectionUrl(projectId, key, service, s);
    const tag = key === IMPLICIT_CACHE_KEY ? ui.dim("  (queue backend)") : "";
    console.log(`  ${ui.bold(label)}  ${ui.cyan(url)}${tag}`);
    console.log(`  ${" ".repeat(width)}  ${ui.dim(resolveServiceEnvName(key, service))}`);
  }
  console.log("");
}

function status(projectDir: string, projectId: string, services: ServicesConfig): void {
  const state = readDevState(projectDir);
  if (!state) {
    ui.note("Nothing provisioned yet — run `laranja dev`.");
    return;
  }
  printTable(projectId, services, state.services);
}

async function teardown(
  projectDir: string,
  composeFile: string,
  project: string,
  action: "down" | "reset",
): Promise<void> {
  if (!existsSync(composeFile)) {
    ui.note("Nothing to stop.");
    return;
  }
  if (action === "reset") {
    // The only destructive command in the set: volumes hold the user's actual
    // development data, which nothing else backs up.
    const ok = await confirm("Delete all local dev data (databases, queues)?");
    if (!ok) return;
  }
  await composeDown(composeFile, project, action === "reset");
  if (action === "reset") {
    rmSync(devStatePath(projectDir), { force: true });
    ui.note("Local dev data deleted.");
  } else {
    ui.note("Services stopped. Data kept — `laranja dev` brings them back.");
  }
}
