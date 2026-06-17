import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { CONFIG_FILENAME } from "@laranja/core";

const TEMPLATE = `import type { LaranjaConfig } from "@laranja/core";

const config: LaranjaConfig = {
  name: "my-app",
  region: "us-east-1",
  // Module that exports your framework app (Express in v1).
  entry: "src/app.ts",
  appExport: "app",
  env: {},
};

export default config;
`;

export function init(projectDir: string): void {
  const file = path.join(projectDir, CONFIG_FILENAME);
  if (existsSync(file)) {
    console.log(`${CONFIG_FILENAME} already exists — nothing to do.`);
    return;
  }
  writeFileSync(file, TEMPLATE);
  console.log(`Created ${CONFIG_FILENAME}.`);
  console.log('Next: set "name"/"entry", then run `laranja deploy`.');
}
