import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Result of probing the local Docker installation. */
export interface DockerProbe {
  ok: boolean;
  reason?: string;
}

/**
 * Check Docker is installed AND running, and that `docker compose` (v2, the
 * subcommand — not the retired `docker-compose` binary) is available.
 *
 * Probed with `docker info` rather than `docker --version`, because the common
 * failure is not a missing install but Docker Desktop being closed — and
 * `--version` answers happily in that state, so the real error would surface
 * later as an unreadable socket message.
 */
export async function probeDocker(): Promise<DockerProbe> {
  try {
    await run("docker", ["info"]);
  } catch (err) {
    const message = (err as Error).message;
    if (/not found|ENOENT/i.test(message)) {
      return { ok: false, reason: "Docker is not installed. See https://docs.docker.com/get-docker/" };
    }
    return { ok: false, reason: "Docker is installed but not running — start Docker and try again." };
  }
  try {
    await run("docker", ["compose", "version"]);
  } catch {
    return { ok: false, reason: "`docker compose` (v2) is unavailable. Update Docker to a current release." };
  }
  return { ok: true };
}

/** Compose project name — namespaces every container and volume by laranja project. */
export function composeProject(projectName: string): string {
  return `laranja-${projectName.replace(/[^A-Za-z0-9]/g, "-").toLowerCase()}`;
}

async function compose(file: string, project: string, args: string[]): Promise<string> {
  const { stdout } = await run("docker", ["compose", "-f", file, "-p", project, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function composeUp(file: string, project: string): Promise<void> {
  await compose(file, project, ["up", "-d", "--remove-orphans"]);
}

/** Stop the stack. `volumes: true` also destroys the data — `dev reset` only. */
export async function composeDown(file: string, project: string, volumes = false): Promise<void> {
  await compose(file, project, ["down", ...(volumes ? ["--volumes"] : [])]);
}

/** True when the named container is running and its healthcheck passes. */
export async function isHealthy(container: string): Promise<boolean> {
  try {
    const { stdout } = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      container,
    ]);
    return stdout.trim() === "healthy";
  } catch {
    return false;
  }
}

/**
 * Wait for every container to report healthy.
 *
 * Health matters more than "started" here: Postgres accepts a TCP connection
 * seconds before it will accept a query, so returning on port-open would hand
 * the user a URL that fails on first use.
 */
export async function waitHealthy(containers: string[], timeoutMs = 90_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(containers);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const container of [...pending]) {
      if (await isHealthy(container)) pending.delete(container);
    }
    if (pending.size === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [...pending];
}
