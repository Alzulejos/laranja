import path from "node:path";
import type { HandlerRef, InfraIR } from "@laranja/core";

/**
 * A generated Lambda entry file. These tiny shims are what the bundler points at:
 * each imports the user's code + the matching runtime factory and re-exports a
 * `handler`. Generating them (rather than asking users to write them) is what
 * makes the decorator-driven model work.
 */
export interface GeneratedEntry {
  /** Logical id of the resulting Lambda (matches the IR id). */
  id: string;
  kind: "http" | "cron" | "queue";
  /** File name to write under the entry dir. */
  fileName: string;
  /** Exported handler symbol (always "handler" for now). */
  handlerExport: string;
  contents: string;
}

export interface GenerateEntriesOptions {
  /** Absolute path to the user's project root. */
  projectDir: string;
  /** Absolute path to the dir the entry files will be written to. */
  entryDir: string;
}

/** Build an import specifier from `fromDir` to a `.ts` source file, posix-style, no extension. */
function importSpecifier(fromDir: string, toFile: string): string {
  let rel = path.relative(fromDir, toFile.replace(/\.ts$/, ""));
  rel = rel.split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Make an id safe to use as a file name. */
function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * The import line + runtime-factory arguments for a handler, branching on whether
 * it's a class method (`Ctor, "method"`) or a standalone function (`fn`).
 */
function handlerWiring(ref: HandlerRef, spec: string): { importLine: string; factoryArgs: string } {
  if (ref.style === "function") {
    return {
      importLine: `import { ${ref.exportName} } from "${spec}";`,
      factoryArgs: ref.exportName,
    };
  }
  return {
    importLine: `import { ${ref.className} } from "${spec}";`,
    factoryArgs: `${ref.className}, "${ref.method}"`,
  };
}

/** Generate all Lambda entry shims for an Infra IR. */
export function generateEntries(ir: InfraIR, opts: GenerateEntriesOptions): GeneratedEntry[] {
  const entries: GeneratedEntry[] = [];

  // HTTP proxy: one Lambda wrapping the whole app. Absent for workers-only apps.
  if (ir.http) {
    const httpTarget = path.join(opts.projectDir, ir.http.handlerEntry);
    const httpSpec = importSpecifier(opts.entryDir, httpTarget);
    const appImport =
      ir.http.appExport === "default"
        ? `import app from "${httpSpec}";`
        : ir.http.appExport === "app"
          ? `import { app } from "${httpSpec}";`
          : `import { ${ir.http.appExport} as app } from "${httpSpec}";`;
    entries.push({
      id: "http",
      kind: "http",
      fileName: "http.ts",
      handlerExport: "handler",
      contents: `${appImport}
import { createHttpHandler } from "@laranja/runtime";

export const handler = createHttpHandler(app);
`,
    });
  }

  // Cron: one Lambda per @Cron method / cron() function.
  for (const cron of ir.crons) {
    const spec = importSpecifier(opts.entryDir, path.join(opts.projectDir, cron.file));
    const { importLine, factoryArgs } = handlerWiring(cron, spec);
    entries.push({
      id: cron.id,
      kind: "cron",
      fileName: `cron-${safe(cron.id)}.ts`,
      handlerExport: "handler",
      contents: `${importLine}
import { createScheduledHandler } from "@laranja/runtime";

export const handler = createScheduledHandler(${factoryArgs});
`,
    });
  }

  // Queue: one consumer Lambda per @Queue method / queue() function.
  for (const queue of ir.queues) {
    const spec = importSpecifier(opts.entryDir, path.join(opts.projectDir, queue.file));
    const { importLine, factoryArgs } = handlerWiring(queue, spec);
    entries.push({
      id: queue.id,
      kind: "queue",
      fileName: `queue-${safe(queue.id)}.ts`,
      handlerExport: "handler",
      contents: `${importLine}
import { createQueueHandler } from "@laranja/runtime";

export const handler = createQueueHandler(${factoryArgs});
`,
    });
  }

  return entries;
}
