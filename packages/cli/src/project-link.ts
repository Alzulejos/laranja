import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  CONFIG_FILENAME,
  getMe,
  createProject,
  ApiRequestError,
  apiErrorMessage,
  type ProjectGroups,
} from "@alzulejos/laranja-core";
import * as ui from "./ui.js";

/** Sentinel value for the "create a new project" choice in the picker. */
const CREATE_NEW = "\0create-new";

/** A dashboard project chosen (or created) via the interactive picker. */
export interface ResolvedProject {
  id: string;
  name: string;
  /** True when it was freshly created (vs. picked from the existing list). */
  created?: boolean;
}

/**
 * Fill the empty `projectId: ""` in the config with a real value. Leaves a
 * non-empty projectId untouched so we never clobber a user's edit. Returns true
 * if the file was updated.
 */
export function writeProjectId(file: string, projectId: string): boolean {
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

/**
 * Fill the empty `name: ""` with the chosen dashboard project's name, mirroring
 * `writeProjectId`. Leaves a non-empty name untouched so we never clobber an edit.
 */
export function writeName(file: string, name: string): boolean {
  if (!name) return false;
  const content = readFileSync(file, "utf8");
  const updated = content.replace(/name:\s*""/, `name: ${JSON.stringify(name)}`);
  if (updated === content) return false;
  writeFileSync(file, updated);
  return true;
}

/**
 * Resolve which dashboard project this directory maps to. If the user has
 * projects, let them pick one or choose to create a new one; with no projects,
 * go straight to creating one. Returns the chosen/created project id (and the
 * name when freshly created), or undefined if the user cancels.
 */
export async function resolveProjectId(
  apiKey: string,
  projects: ProjectGroups,
): Promise<ResolvedProject | undefined> {
  const all = [...projects.personal, ...projects.collaborating];
  let choice: string | undefined;
  if (all.length > 0) {
    // Group the picker into "Your projects" / "Shared with you" sections, only
    // showing a heading for a group that actually has projects.
    const section = (title: string, list: typeof all) =>
      list.length > 0
        ? [
            { label: title, value: "", header: true },
            ...list.map((p) => ({
              label: p.framework
                ? `${p.name} ${ui.dim(`(${p.framework})`)}`
                : p.name,
              value: p.id,
            })),
          ]
        : [];

    choice = await ui.select("Which project is this? (↑/↓, Enter)", [
      ...section("Your projects", projects.personal),
      ...section("Shared with you", projects.collaborating),
      { label: ui.orange("＋ Create a new project"), value: CREATE_NEW },
    ]);
    if (!choice) return undefined; // cancelled
    if (choice !== CREATE_NEW) {
      const picked = all.find((p) => p.id === choice);
      return { id: choice, name: picked?.name ?? "" };
    }
  }

  // No projects yet, or the user chose to create one.
  const name = await ui.promptText("New project name:");
  if (!name) return undefined;
  const created = await createProject(name, apiKey);
  return { id: created.id, name, created: true };
}

/** True if laranja.config.ts already carries a non-empty projectId. */
function isLinked(file: string): boolean {
  if (!existsSync(file)) return false;
  const m = readFileSync(file, "utf8").match(/projectId:\s*"([^"]*)"/);
  return Boolean(m && m[1]);
}

/**
 * Ensure this directory is linked to a dashboard project before a deploy/plan.
 * If the config already has a projectId, this is a no-op. Otherwise it shows the
 * same picker `laranja init` uses — pick an existing project or create a new one
 * — and writes the chosen id + name into laranja.config.ts, so the subsequent
 * `loadConfig` succeeds (that's also why linking runs BEFORE load: an unlinked
 * config has an empty `name`, which `loadConfig` rejects).
 *
 * Requires an interactive TTY; in a non-interactive shell (CI) it does nothing
 * and lets the normal "set projectId"/"name is required" error surface instead
 * of hanging on a prompt no one can answer.
 */
export async function ensureProjectLinked(
  projectDir: string,
  apiKey: string,
): Promise<void> {
  const file = path.join(projectDir, CONFIG_FILENAME);
  if (isLinked(file)) return;
  if (!existsSync(file)) return; // no config at all — let loadConfig raise its own error
  if (!process.stdin.isTTY) return; // CI: fall through to the clear config error

  let me;
  try {
    me = await getMe(apiKey);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      throw new Error(apiErrorMessage("Handshake failed", err));
    }
    throw err;
  }

  ui.warn(`This directory isn't linked to a project yet — let's connect it.`);
  const resolved = await resolveProjectId(apiKey, me.projects);
  if (!resolved) {
    throw new Error(
      `No project selected — set "projectId" in ${CONFIG_FILENAME} or run \`laranja init\`.`,
    );
  }

  writeProjectId(file, resolved.id);
  writeName(file, resolved.name);
  if (resolved.created) {
    console.log(
      `  ${ui.green("✓")} Created project ${ui.bold(resolved.name)} — it's now on your dashboard.`,
    );
  }
  console.log(
    `  ${ui.green("✓")} Linked ${CONFIG_FILENAME} to project ${ui.bold(resolved.name)}.`,
  );
}
