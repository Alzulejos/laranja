import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  CONFIG_FILENAME,
  getMe,
  createProject,
  resolveApiKey,
  resolveApiUrl,
  loadStoredApiKey,
  storeAuth,
  ApiRequestError,
  type Project,
} from "@alzulejos/laranja-core";
import { generateResourceTypesStub } from "@alzulejos/laranja-scanner";
import * as ui from "../ui.js";
import { RESOURCE_TYPES_FILE } from "../resource-types.js";

const TEMPLATE = `import type { TypedLaranjaConfig } from "./laranja.types.js";

const config: TypedLaranjaConfig = {
  name: "my-app",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "",
  region: "eu-central-1",
  // Module that exports your framework app (Express in v1).
  entry: "src/app.ts",
  appExport: "app",
  env: {},
  // Default compute for every function (the HTTP proxy + each cron/queue).
  compute: { memory: 256, timeout: 30 },
  // Per-resource overrides, keyed by resource id ("http", or a cron/queue id).
  // Filled in once you have resources, e.g.:
  // resources: { cleanup: { memory: 512, timeout: 60 } },
};

export default config;
`;

/**
 * Fill the empty `projectId: ""` in the config with the value from `/me`.
 * Leaves a non-empty projectId untouched so we never clobber a user's edit.
 * Returns true if the file was updated.
 */
function writeProjectId(file: string, projectId: string): boolean {
  if (!projectId) return false;
  const content = readFileSync(file, "utf8");
  const updated = content.replace(
    /projectId:\s*""/,
    `projectId: ${JSON.stringify(projectId)}`,
  );
  if (updated === content) return false;
  writeFileSync(file, updated);
  return true;
}

/** Sentinel value for the "create a new project" choice in the picker. */
const CREATE_NEW = "\0create-new";

/**
 * Resolve which dashboard project this directory maps to. If the user has
 * projects, let them pick one or choose to create a new one; with no projects,
 * go straight to creating one. Returns the chosen/created project id (and the
 * name when freshly created), or undefined if the user cancels.
 */
async function resolveProjectId(
  apiKey: string,
  projects: Project[],
): Promise<{ id: string; createdName?: string } | undefined> {
  let choice: string | undefined;
  if (projects.length > 0) {
    choice = await ui.select("Which project is this? (↑/↓, Enter)", [
      ...projects.map((p) => ({
        label: p.framework ? `${p.name} ${ui.dim(`(${p.framework})`)}` : p.name,
        value: p.id,
      })),
      { label: ui.orange("＋ Create a new project"), value: CREATE_NEW },
    ]);
    if (!choice) return undefined; // cancelled
    if (choice !== CREATE_NEW) return { id: choice };
  }

  // No projects yet, or the user chose to create one.
  const name = await ui.promptText("New project name:");
  if (!name) return undefined;
  const created = await createProject(name, apiKey);
  return { id: created.id, createdName: name };
}

export async function init(projectDir: string): Promise<void> {
  const file = path.join(projectDir, CONFIG_FILENAME);
  if (existsSync(file)) {
    console.log(`${CONFIG_FILENAME} already exists — nothing to do.`);
  } else {
    writeFileSync(file, TEMPLATE);
    console.log(`Created ${CONFIG_FILENAME}.`);
  }

  // The config imports `TypedLaranjaConfig` from here; seed a permissive stub so
  // the import resolves before the first deploy/synth regenerates it with real ids.
  const typesFile = path.join(projectDir, RESOURCE_TYPES_FILE);
  if (!existsSync(typesFile)) {
    writeFileSync(typesFile, generateResourceTypesStub());
    console.log(`Created ${RESOURCE_TYPES_FILE}.`);
  }

  // Handshake: validate the API key against the server before the user deploys.
  // Precedence: env var / already-stored key, else prompt for it interactively.
  let apiKey = resolveApiKey();
  if (!apiKey) {
    apiKey = await ui.promptSecret("Paste your laranja API key:");
    if (!apiKey) {
      console.log(
        `\n  ${ui.dim("No API key provided. Set LARANJA_API_KEY (or re-run `laranja init`) to connect your account.")}`,
      );
      return;
    }
  }

  try {
    const me = await getMe(apiKey);
    console.log(
      `\n  ${ui.green("✓")} Hi ${ui.bold(me.displayName)}, let's ship something great! 🍊`,
    );

    // Persist the validated key so future commands don't need it re-exported.
    // Skip the write if it's already what's on disk (e.g. supplied via env).
    if (apiKey !== loadStoredApiKey()) {
      const stored = storeAuth({ apiKey, apiUrl: resolveApiUrl() });
      console.log(
        `  ${ui.dim(`Saved your API key to ${stored} — no need to re-export it.`)}`,
      );
    }

    // Link this dir to a dashboard project — but only if `projectId` is still
    // empty, so we never clobber a value the user already set.
    if (/projectId:\s*""/.test(readFileSync(file, "utf8"))) {
      const resolved = await resolveProjectId(apiKey, me.projects);
      if (resolved) {
        writeProjectId(file, resolved.id);
        if (resolved.createdName) {
          console.log(
            `  ${ui.green("✓")} Created project ${ui.bold(resolved.createdName)} — it's now on your dashboard.`,
          );
        }
        console.log(
          `  ${ui.dim(`Linked ${CONFIG_FILENAME} to project ${resolved.id}.`)}`,
        );
      } else {
        console.log(
          `  ${ui.dim(`No project selected — set "projectId" in ${CONFIG_FILENAME} before deploying.`)}`,
        );
      }
    }
    console.log('  Next: set "name"/"entry", then run `laranja deploy`.');
  } catch (err) {
    if (err instanceof ApiRequestError) {
      const hint =
        err.code === "unauthorized"
          ? "check LARANJA_API_KEY"
          : err.status === 0
            ? `is the server running at ${resolveApiUrl()}?`
            : err.message;
      throw new Error(`Handshake failed — ${hint}`);
    }
    throw err;
  }
}
