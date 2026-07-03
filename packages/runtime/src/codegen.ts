import path from "node:path";
import type { HandlerRef, InfraIR } from "@alzulejos/laranja-core";

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
  /**
   * Absolute path the HTTP shim should import instead of `<projectDir>/<http.handlerEntry>`.
   * Used for Nest: the shim imports the user's COMPILED bootstrap (e.g.
   * `dist/main.js`, which carries the DI metadata their build emitted) rather than
   * the `.ts` source. Ignored for the worker shims.
   */
  httpEntry?: string;
  /**
   * Absolute path to the user's COMPILED `workers(AppModule)` module. Required when
   * a Nest project has class-based (@Cron/@Queue) workers — their shims build a DI
   * context from it. Same metadata rationale as `httpEntry`.
   */
  workersEntry?: string;
  /**
   * Map a source handler file to its COMPILED path. Nest class-based workers must
   * import the compiled provider (DI metadata intact), not the `.ts` source. Absent
   * for Express, where shims bundle straight from source.
   */
  resolveCompiled?: (file: string) => string;
}

/** Build an import specifier from `fromDir` to a source file, posix-style, no extension. */
function importSpecifier(fromDir: string, toFile: string): string {
  let rel = path.relative(fromDir, toFile.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, ""));
  rel = rel.split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Make an id safe to use as a file name. */
function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** An `import` line binding a (possibly-default, possibly-aliased) export to a local name. */
function importBinding(local: string, exportName: string, spec: string): string {
  if (exportName === "default") return `import ${local} from "${spec}";`;
  if (exportName === local) return `import { ${local} } from "${spec}";`;
  return `import { ${exportName} as ${local} } from "${spec}";`;
}

/**
 * The Nest DI shim for a class-based worker: import the compiled provider and the
 * compiled `workers(AppModule)` module, build a standalone context, and let the
 * runtime factory resolve the provider through DI. `NestFactory` is imported from
 * the user's own `@nestjs/core` (present in a Nest project), keeping the runtime
 * package framework-agnostic.
 */
function nestWorkerShim(
  ref: { className: string; method: string; file: string },
  factory: "createNestScheduledHandler" | "createNestQueueHandler",
  workersAppExport: string,
  opts: GenerateEntriesOptions,
): string {
  if (!opts.workersEntry || !opts.resolveCompiled) {
    throw new Error(
      `Cannot generate a Nest worker shim for ${ref.className}.${ref.method}: ` +
        `missing the compiled workers(AppModule) module. Add \`export default workers(AppModule)\` and build first.`,
    );
  }
  const providerSpec = importSpecifier(opts.entryDir, opts.resolveCompiled(ref.file));
  const workersSpec = importSpecifier(opts.entryDir, opts.workersEntry);
  const workersImport = importBinding("workersModule", workersAppExport, workersSpec);
  return `import { NestFactory } from "@nestjs/core";
${workersImport}
import { ${ref.className} } from "${providerSpec}";
import { ${factory} } from "@alzulejos/laranja-runtime";

export const handler = ${factory}(
  () => NestFactory.createApplicationContext(workersModule),
  ${ref.className},
  "${ref.method}",
);
`;
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
  const isNest = ir.app.framework === "nest";
  const workersExport = ir.workers?.appExport ?? "default";

  // HTTP proxy: one Lambda wrapping the whole app. Absent for workers-only apps.
  // Express exports a ready app instance (createHttpHandler(app)); Nest exports an
  // async bootstrap factory that returns the app (createNestHttpHandler(bootstrap)),
  // and its shim imports the COMPILED bootstrap via `opts.httpEntry`.
  if (ir.http) {
    const local = isNest ? "bootstrap" : "app";
    const factory = isNest ? "createNestHttpHandler" : "createHttpHandler";
    const httpTarget = opts.httpEntry ?? path.join(opts.projectDir, ir.http.handlerEntry);
    const httpSpec = importSpecifier(opts.entryDir, httpTarget);
    const appImport = importBinding(local, ir.http.appExport, httpSpec);
    entries.push({
      id: "http",
      kind: "http",
      fileName: "http.ts",
      handlerExport: "handler",
      contents: `${appImport}
import { ${factory} } from "@alzulejos/laranja-runtime";

export const handler = ${factory}(${local});
`,
    });
  }

  // Cron: one Lambda per @Cron method / cron() function. A Nest class-based cron
  // resolves its provider through DI (nestWorkerShim); everything else — Express
  // classes and standalone cron() functions — is `new`'d / called directly.
  for (const cron of ir.crons) {
    let contents: string;
    if (isNest && cron.style === "method") {
      contents = nestWorkerShim(cron, "createNestScheduledHandler", workersExport, opts);
    } else {
      const spec = importSpecifier(opts.entryDir, path.join(opts.projectDir, cron.file));
      const { importLine, factoryArgs } = handlerWiring(cron, spec);
      contents = `${importLine}
import { createScheduledHandler } from "@alzulejos/laranja-runtime";

export const handler = createScheduledHandler(${factoryArgs});
`;
    }
    entries.push({ id: cron.id, kind: "cron", fileName: `cron-${safe(cron.id)}.ts`, handlerExport: "handler", contents });
  }

  // Queue: one consumer Lambda per @Queue method / queue() function. Same DI split.
  for (const queue of ir.queues) {
    let contents: string;
    if (isNest && queue.style === "method") {
      contents = nestWorkerShim(queue, "createNestQueueHandler", workersExport, opts);
    } else {
      const spec = importSpecifier(opts.entryDir, path.join(opts.projectDir, queue.file));
      const { importLine, factoryArgs } = handlerWiring(queue, spec);
      contents = `${importLine}
import { createQueueHandler } from "@alzulejos/laranja-runtime";

export const handler = createQueueHandler(${factoryArgs});
`;
    }
    entries.push({ id: queue.id, kind: "queue", fileName: `queue-${safe(queue.id)}.ts`, handlerExport: "handler", contents });
  }

  return entries;
}
