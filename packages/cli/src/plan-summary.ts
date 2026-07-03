import type { InfraIR } from "@alzulejos/laranja-core";
import * as ui from "./ui.js";

/**
 * Minimal structural view of a CDK `TemplateDiff` — only the bits we read. A
 * real `@aws-cdk/cloudformation-diff` `TemplateDiff` satisfies this shape, so we
 * avoid a direct dependency on that (transitive) package's types.
 */
interface ResourceChange {
  readonly isAddition: boolean;
  readonly isRemoval: boolean;
}
export interface StackDiffView {
  readonly resources: { readonly changes: Record<string, ResourceChange> };
}

type Status = "created" | "changed" | "removed" | "unchanged";

const MARK: Record<Status, string> = {
  created: ui.green("+"),
  changed: ui.orange("~"),
  removed: ui.red("-"),
  unchanged: ui.dim("="),
};
const PAINT: Record<Status, (s: string) => string> = {
  created: ui.green,
  changed: ui.orange,
  removed: ui.red,
  unchanged: ui.dim,
};

/** Mirror how CDK derives logical-id prefixes from construct ids (drops non-alphanumerics). */
const idKey = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");

interface Entity {
  kind: "HTTP" | "Cron" | "Queue";
  name: string;
  detail: string;
  /** Logical-id prefixes the server's synth gives this entity's resources. */
  prefixes: string[];
}

function entitiesFromIr(ir: InfraIR): Entity[] {
  const out: Entity[] = [];
  if (ir.http) {
    const n = ir.http.routes.length;
    out.push({
      kind: "HTTP",
      name: "http",
      detail: `${n} route${n === 1 ? "" : "s"} → proxy Lambda + Function URL`,
      prefixes: ["Http"],
    });
  }
  for (const c of ir.crons) {
    out.push({ kind: "Cron", name: c.id, detail: "Lambda + EventBridge rule", prefixes: [`Cron${idKey(c.id)}`] });
  }
  for (const q of ir.queues) {
    out.push({
      kind: "Queue",
      name: q.id,
      detail: "SQS + consumer Lambda",
      prefixes: [`Queue${idKey(q.id)}`, `Consumer${idKey(q.id)}`],
    });
  }
  return out;
}

/** Status for every logical id in the new template, plus any resources the diff removed. */
function resourceStatuses(template: Record<string, unknown>, diff: StackDiffView): Map<string, Status> {
  const out = new Map<string, Status>();
  const resources = (template.Resources as Record<string, unknown> | undefined) ?? {};
  for (const id of Object.keys(resources)) out.set(id, "unchanged");
  for (const [id, change] of Object.entries(diff.resources?.changes ?? {})) {
    out.set(id, change.isAddition ? "created" : change.isRemoval ? "removed" : "changed");
  }
  return out;
}

/** Assign a logical id to the entity whose prefix it matches longest (so "daily" never steals "dailyreport"). */
function entityFor(logicalId: string, entities: Entity[]): Entity | undefined {
  let best: Entity | undefined;
  let bestLen = 0;
  for (const e of entities) {
    for (const p of e.prefixes) {
      if (p.length > bestLen && logicalId.startsWith(p)) {
        best = e;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** Collapse an entity's per-resource statuses into one. */
function rollup(statuses: Status[]): Status {
  if (statuses.length === 0) return "unchanged";
  if (statuses.every((s) => s === "created")) return "created";
  if (statuses.every((s) => s === "removed")) return "removed";
  if (statuses.some((s) => s !== "unchanged")) return "changed";
  return "unchanged";
}

/**
 * Print the laranja plan table: one row per app concept (HTTP / each cron / each
 * queue) tagged created / changed / unchanged / removed, plus an AWS-resource
 * tally. Built from the IR (for the friendly rows), the synthesized template (the
 * full resource set), and the diff against the live stack (what actually changed).
 */
export function summarizePlan(ir: InfraIR, template: Record<string, unknown>, diff: StackDiffView): void {
  const entities = entitiesFromIr(ir);
  const statuses = resourceStatuses(template, diff);

  const perEntity = new Map<Entity, Status[]>(entities.map((e) => [e, []]));
  for (const [id, status] of statuses) {
    const e = entityFor(id, entities);
    if (e) perEntity.get(e)!.push(status);
  }

  console.log(`\n  Plan for ${ui.bold(`"${ir.app.name}"`)}\n`);

  // One aligned row per app concept: "<mark> <name>  <kind>  <detail>".
  const nameW = Math.max(...entities.map((e) => e.name.length), 0);
  const kindW = Math.max(...entities.map((e) => e.kind.length), 0);
  for (const e of entities) {
    const status = rollup(perEntity.get(e)!);
    const name = PAINT[status](e.name.padEnd(nameW));
    const kind = ui.dim(e.kind.padEnd(kindW));
    console.log(`  ${MARK[status]} ${name}  ${kind}  ${ui.dim(e.detail)}`);
  }

  const all = [...statuses.values()];
  const count = (s: Status) => all.filter((x) => x === s).length;
  const tally = [
    count("created") && ui.green(`+${count("created")} created`),
    count("changed") && ui.orange(`~${count("changed")} changed`),
    count("removed") && ui.red(`-${count("removed")} removed`),
    ui.dim(`=${count("unchanged")} unchanged`),
  ].filter(Boolean) as string[];

  console.log(`\n  ${ui.dim(`${all.length} AWS resources`)}  ${tally.join("  ")}`);
  if (all.every((s) => s === "unchanged")) {
    console.log(`  ${ui.dim("No changes — your deployed stack already matches this code.")}`);
  }
}
