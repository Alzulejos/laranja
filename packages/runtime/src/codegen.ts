import path from "node:path";
import type { CronIR, HandlerRef, InfraIR, QueueIR, WorkersIR } from "@alzulejos/laranja-core";

/**
 * A generated Lambda entry file. These tiny shims are what the bundler points at:
 * each imports the user's code + the matching runtime factory and re-exports a
 * `handler`. Generating them (rather than asking users to write them) is what
 * makes the decorator-driven model work.
 */
export interface GeneratedEntry {
  /** Logical id of the resulting Lambda (matches the IR id). */
  id: string;
  /** "worker" = a consolidated Nest module Lambda hosting several crons/queues. */
  kind: "http" | "cron" | "queue" | "worker";
  /** File name to write under the entry dir. */
  fileName: string;
  /**
   * Exported handler symbol ("handler" on AWS). EMPTY on Azure, where the shim
   * registers with the Functions host as a side effect and there is no symbol to
   * export — the host discovers functions from the loaded package.
   */
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
   * Map a source file to its COMPILED path. Nest class-based workers must import the
   * compiled provider AND their compiled `workers(...)` module (DI metadata intact),
   * not the `.ts` source. Absent for Express, where shims bundle straight from source.
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
 * The consolidated Nest worker shim: ONE Lambda for a whole `workers()` module.
 * Imports the compiled module once + each hosted provider once, then wires a
 * `createNestWorkerDispatcher` with two routing tables — crons keyed by id (the
 * EventBridge input), queues keyed by name (the SQS source). `NestFactory` is
 * imported from the user's own `@nestjs/core`, keeping the runtime package
 * framework-agnostic.
 */
function workerDispatcherShim(
  worker: WorkersIR,
  crons: CronIR[],
  queues: QueueIR[],
  opts: GenerateEntriesOptions,
): string {
  if (!opts.resolveCompiled) {
    throw new Error(
      `Cannot generate the worker shim for "${worker.id}": missing the compiled module. ` +
        `Add \`export default workers(${worker.id})\` and build first.`,
    );
  }
  const resolve = opts.resolveCompiled;
  const workersSpec = importSpecifier(opts.entryDir, resolve(worker.handlerEntry));
  const workersImport = importBinding("workersModule", worker.appExport, workersSpec);

  // Import each provider class once, even if it hosts several methods.
  const providerImports = new Map<string, string>();
  const cronRows: string[] = [];
  const queueRows: string[] = [];
  for (const c of crons) {
    if (c.style !== "method") continue;
    providerImports.set(c.className, importSpecifier(opts.entryDir, resolve(c.file)));
    cronRows.push(`      "${c.id}": [${c.className}, "${c.method}"],`);
  }
  for (const q of queues) {
    if (q.style !== "method") continue;
    providerImports.set(q.className, importSpecifier(opts.entryDir, resolve(q.file)));
    queueRows.push(`      "${q.name}": [${q.className}, "${q.method}"],`);
  }
  const imports = [...providerImports].map(([cls, spec]) => `import { ${cls} } from "${spec}";`).join("\n");

  return `import { NestFactory } from "@nestjs/core";
${workersImport}
${imports}
import { createNestWorkerDispatcher } from "@alzulejos/laranja-runtime";

export const handler = createNestWorkerDispatcher(
  () => NestFactory.createApplicationContext(workersModule),
  {
    crons: {
${cronRows.join("\n")}
    },
    queues: {
${queueRows.join("\n")}
    },
  },
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
  const workers = ir.workers ?? [];
  // A method-style Nest handler is GROUPED into its module's one worker Lambda.
  const isGrouped = (h: HandlerRef & { workersId?: string }): boolean =>
    isNest && h.style === "method" && h.workersId !== undefined;

  // HTTP proxy: one Lambda wrapping the whole app. Absent for workers-only apps.
  // Express exports a ready app instance (createHttpHandler(app)); Nest exports an
  // async bootstrap factory that returns the app (createNestHttpHandler(bootstrap)),
  // and its shim imports the COMPILED bootstrap via `opts.httpEntry`.
  if (ir.http) {
    const local = isNest ? "bootstrap" : "app";
    const httpTarget = opts.httpEntry ?? path.join(opts.projectDir, ir.http.handlerEntry);
    const httpSpec = importSpecifier(opts.entryDir, httpTarget);
    const appImport = importBinding(local, ir.http.appExport, httpSpec);

    // Azure has no handler export to look up: the Functions host discovers
    // functions by loading the package and reading what it registered. So the
    // shim REGISTERS (a side effect at module top level) instead of exporting.
    // `handlerExport` is left empty to say so.
    if (ir.app.provider === "azure") {
      if (isNest) {
        throw new Error(
          `Azure support is Express-only today — this project's http() marker is a NestJS bootstrap.\n` +
            `  Deploy to AWS (provider: "aws") for now; Azure + NestJS is the next step.`,
        );
      }
      // Azure hosts EVERY function in ONE package: the HTTP proxy plus each cron's
      // timer all register (as side effects) from this single entry, and the host
      // discovers them by loading it. So crons are folded in here rather than
      // emitted as separate entries — which is also why the cron loop below skips
      // Azure and the whole app keeps one asset (keyed "http") end to end.
      const userImports = new Map<string, string>(); // importLine -> itself (dedupe)
      userImports.set(appImport, appImport);
      const runtimeImports = new Set<string>(["registerAzureHttp"]);
      const registrations = [`registerAzureHttp(${local});`];
      for (const cron of ir.crons) {
        // workersId (Nest method) crons are rejected upstream; these are standalone.
        const spec = importSpecifier(opts.entryDir, path.join(opts.projectDir, cron.file));
        const { importLine, factoryArgs } = handlerWiring(cron, spec);
        // Dedupe: several methods on one class share a single class import.
        userImports.set(importLine, importLine);
        runtimeImports.add("registerAzureCron");
        registrations.push(`registerAzureCron(${JSON.stringify(cron.id)}, ${factoryArgs});`);
      }
      entries.push({
        id: "http",
        kind: "http",
        fileName: "http.ts",
        handlerExport: "",
        contents: `${[...userImports.keys()].join("\n")}
import { ${[...runtimeImports].join(", ")} } from "@alzulejos/laranja-runtime";

${registrations.join("\n")}
`,
      });
    } else {
      const factory = isNest ? "createNestHttpHandler" : "createHttpHandler";
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
  }

  // Worker Lambdas: one per `workers()` module, hosting all its grouped (method-
  // style) crons + queues behind a single dispatcher. This is where bundle
  // duplication disappears — the module's DI graph is bundled once, not per handler.
  for (const w of workers) {
    const crons = ir.crons.filter((c) => c.workersId === w.id && c.style === "method");
    const queues = ir.queues.filter((q) => q.workersId === w.id && q.style === "method");
    if (crons.length === 0 && queues.length === 0) continue;
    entries.push({
      id: w.id,
      kind: "worker",
      fileName: `worker-${safe(w.id)}.ts`,
      handlerExport: "handler",
      contents: workerDispatcherShim(w, crons, queues, opts),
    });
  }

  // Cron: one Lambda per STANDALONE @Cron / cron() (Express classes, or function-
  // style). Grouped Nest crons are hosted by their worker Lambda above.
  // Azure has no per-cron entry — its crons are folded into the one app package
  // in the http branch above — so this AWS-shaped loop skips them.
  for (const cron of ir.crons) {
    if (ir.app.provider === "azure") break;
    if (isGrouped(cron)) continue;
    const spec = importSpecifier(opts.entryDir, path.join(opts.projectDir, cron.file));
    const { importLine, factoryArgs } = handlerWiring(cron, spec);
    entries.push({
      id: cron.id,
      kind: "cron",
      fileName: `cron-${safe(cron.id)}.ts`,
      handlerExport: "handler",
      contents: `${importLine}
import { createScheduledHandler } from "@alzulejos/laranja-runtime";

export const handler = createScheduledHandler(${factoryArgs});
`,
    });
  }

  // Queue: one consumer Lambda per STANDALONE @Queue / queue(). Grouped Nest
  // queues are hosted by their worker Lambda above.
  for (const queue of ir.queues) {
    if (isGrouped(queue)) continue;
    const spec = importSpecifier(opts.entryDir, path.join(opts.projectDir, queue.file));
    const { importLine, factoryArgs } = handlerWiring(queue, spec);
    entries.push({
      id: queue.id,
      kind: "queue",
      fileName: `queue-${safe(queue.id)}.ts`,
      handlerExport: "handler",
      contents: `${importLine}
import { createQueueHandler } from "@alzulejos/laranja-runtime";

export const handler = createQueueHandler(${factoryArgs});
`,
    });
  }

  return entries;
}
