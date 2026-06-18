import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { CONFIG_FILENAME, getMe, resolveApiKey, resolveApiUrl, ApiRequestError } from "@laranja/core";
import * as ui from "../ui.js";

const TEMPLATE = `import type { LaranjaConfig } from "@laranja/core";

const config: LaranjaConfig = {
  name: "my-app",
  // From your laranja dashboard — identifies this project on the server.
  projectId: "",
  region: "us-east-1",
  // Module that exports your framework app (Express in v1).
  entry: "src/app.ts",
  appExport: "app",
  env: {},
};

export default config;
`;

export async function init(projectDir: string): Promise<void> {
  const file = path.join(projectDir, CONFIG_FILENAME);
  if (existsSync(file)) {
    console.log(`${CONFIG_FILENAME} already exists — nothing to do.`);
  } else {
    writeFileSync(file, TEMPLATE);
    console.log(`Created ${CONFIG_FILENAME}.`);
  }

  // Handshake: validate the API key against the server before the user deploys.
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.log(
      `\n  ${ui.dim("Set LARANJA_API_KEY to connect your account, then re-run `laranja init`.")}`,
    );
    return;
  }

  try {
    const me = await getMe(apiKey);
    console.log(`\n  ${ui.green("✓")} Connected — tier ${ui.bold(me.tier)}.`);
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
