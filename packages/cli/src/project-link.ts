import { readFileSync, writeFileSync } from "node:fs";
import { createProject, type ProjectGroups } from "@alzulejos/laranja-core";
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
