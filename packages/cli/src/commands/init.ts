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

const AWS_TEMPLATE = `import type { TypedLaranjaConfig } from "./laranja.types.js";

const config: TypedLaranjaConfig = {
  // Both filled in from the dashboard project you pick during \`laranja init\`.
  name: "",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "",
  provider: "aws",
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

/** Azure config. `__SUBSCRIPTION__`/`__RESOURCE_GROUP__` are filled in by init. */
const AZURE_TEMPLATE = `import type { TypedLaranjaConfig } from "./laranja.types.js";

const config: TypedLaranjaConfig = {
  // Both filled in from the dashboard project you pick during \`laranja init\`.
  name: "",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "",
  provider: "azure",
  // Azure region. Must support Flex Consumption AND accept new customers.
  region: "__REGION__",
  // Google/AWS have account discovery; Azure does not — these are required.
  azure: {
    subscriptionId: "__SUBSCRIPTION__",
    resourceGroup: "__RESOURCE_GROUP__",
  },
  env: {},
  // Instance memory is a fixed set on Flex Consumption (512/2048/4096);
  // other values snap up to the nearest. timeout lands in host.json.
  compute: { memory: 512, timeout: 30 },
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
    // Ask which cloud, then scaffold a provider-appropriate config. Azure has no
    // credential-based account discovery, so collect its required identifiers now
    // — that's also what lets the preflight below actually check the environment.
    const provider =
      (await ui.select("Which cloud do you want to deploy to?", [
        { label: "AWS", value: "aws" as const },
        { label: "Azure  (HTTP + Express today)", value: "azure" as const },
      ])) ?? "aws";

    let template = AWS_TEMPLATE;
    if (provider === "azure") {
      const subscriptionId =
        (await ui.promptText("Azure subscription id (az account show --query id -o tsv):")) ?? "__SUBSCRIPTION__";
      const resourceGroup =
        (await ui.promptText("Azure resource group (must already exist):")) ?? "__RESOURCE_GROUP__";
      const region = (await ui.promptText("Azure region [westus2]:")) || "westus2";
      template = AZURE_TEMPLATE.replace("__SUBSCRIPTION__", subscriptionId)
        .replace("__RESOURCE_GROUP__", resourceGroup)
        .replace("__REGION__", region);
    }
    writeFileSync(file, template);
    console.log(`Created ${CONFIG_FILENAME} (${provider}).`);
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
    `  ${ui.dim(`You can change any of this later in ${CONFIG_FILENAME}.`)}`,
  );
  console.log(
    "  Next: wrap your app with `export default http(app)`, then run `laranja deploy`.",
  );
  // Note: the cloud-environment preflight (credentials, providers, resource
  // group) runs at DEPLOY time, not here — at init the values may still be
  // placeholders, and the check belongs where it prevents a real failure.
}
