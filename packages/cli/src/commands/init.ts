import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  CONFIG_FILENAME,
  getMe,
  resolveApiKey,
  resolveApiUrl,
  loadStoredApiKey,
  storeAuth,
  ApiRequestError,
  apiErrorMessage,
} from "@alzulejos/laranja-core";
import { generateResourceTypesStub } from "@alzulejos/laranja-scanner";
import * as ui from "../ui.js";
import { RESOURCE_TYPES_FILE } from "../resource-types.js";
import { resolveProjectId, writeProjectId, writeName } from "../project-link.js";

const TEMPLATE = `import type { TypedLaranjaConfig } from "./laranja.types.js";

const config: TypedLaranjaConfig = {
  // Both filled in from the dashboard project you pick during \`laranja init\`.
  name: "",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "",
  region: "eu-central-1",
  env: {},
  // Emit a CloudWatch dashboard (\`<name>-<stage>\`) with per-function metrics —
  // invocations, errors, throttles, duration. Set false to skip it. Defaults to true.
  monitoring: true,
  // Default compute for every function (the HTTP proxy + each cron/queue).
  compute: { memory: 256, timeout: 30 },
  // Per-resource overrides, keyed by resource id ("http", or a cron/queue id).
  // Filled in once you have resources, e.g.:
  // resources: { cleanup: { memory: 512, timeout: 60 } },
};

export default config;
`;

export async function init(projectDir: string): Promise<void> {
  // Handshake first: validate the API key against the server BEFORE scaffolding
  // any files, so a bad/expired token never leaves a stray laranja.config.ts.
  // Precedence: env var / already-stored key, else prompt for it interactively.
  let apiKey = resolveApiKey();
  if (!apiKey) {
    console.log(
      `\n  ${ui.orange("🍊 Welcome to laranja")} ${ui.dim("·")} ${ui.bold("let's get you set up")}`,
    );
    console.log(
      `  ${ui.dim("Connect this directory to your account and ship in one command.")}\n`,
    );
    console.log(
      `  ${ui.dim("Find your API key in the dashboard under")} ${ui.bold("Account → API keys")}${ui.dim(".")}\n`,
    );
    apiKey = await ui.promptSecret("Paste your laranja API key:");
    if (!apiKey) {
      console.log(
        `\n  ${ui.dim("No API key provided. Set LARANJA_API_KEY (or re-run `laranja init`) to connect your account.")}`,
      );
      return;
    }
  }

  let me;
  try {
    me = await getMe(apiKey);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      throw new Error(apiErrorMessage("Handshake failed", err));
    }
    throw err;
  }
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

  const file = path.join(projectDir, CONFIG_FILENAME);
  const typesFile = path.join(projectDir, RESOURCE_TYPES_FILE);
  const configExists = existsSync(file);

  // Pick the dashboard project BEFORE scaffolding anything, so cancelling the
  // picker never leaves a stray config/types file behind. An existing config is
  // only re-linked when its `projectId` is still empty (never clobber a value).
  const needsLink =
    !configExists || /projectId:\s*""/.test(readFileSync(file, "utf8"));
  let resolved: Awaited<ReturnType<typeof resolveProjectId>>;
  if (needsLink) {
    resolved = await resolveProjectId(apiKey, me.projects);
    if (!resolved && !configExists) {
      console.log(
        `  ${ui.dim("No project selected — nothing was created. Re-run `laranja init` when you're ready.")}`,
      );
      return;
    }
  }

  // Key is valid and a project is chosen — now it's safe to scaffold the files.
  if (configExists) {
    console.log(`${CONFIG_FILENAME} already exists — nothing to do.`);
  } else {
    writeFileSync(file, TEMPLATE);
    console.log(`Created ${CONFIG_FILENAME}.`);
  }

  // The config imports `TypedLaranjaConfig` from here; seed a permissive stub so
  // the import resolves before the first deploy/plan regenerates it with real ids.
  if (!existsSync(typesFile)) {
    writeFileSync(typesFile, generateResourceTypesStub());
    console.log(`Created ${RESOURCE_TYPES_FILE}.`);
  }

  if (resolved) {
    writeProjectId(file, resolved.id);
    writeName(file, resolved.name);
    if (resolved.created) {
      console.log(
        `  ${ui.green("✓")} Created project ${ui.bold(resolved.name)} — it's now on your dashboard.`,
      );
    }
    console.log(
      `  ${ui.dim(`Linked ${CONFIG_FILENAME} to project ${resolved.id}.`)}`,
    );
  } else if (needsLink) {
    console.log(
      `  ${ui.dim(`No project selected — set "projectId" in ${CONFIG_FILENAME} before deploying.`)}`,
    );
  }
  console.log(
    "  Next: wrap your app with `export default http(app)`, then run `laranja deploy`.",
  );
}
