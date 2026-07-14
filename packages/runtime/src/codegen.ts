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
  /** Exported handler symbol (always "handler" for now). */
  handlerExport: string;
  contents: string;
}

export interface GenerateEntriesOptions {
  /** Absolute path to the user's project root. */
  projectDir: string;
  /**
   * Absolute path to the runnable HTTP entry the shim imports (the built output the
   * deploy ships), e.g. `dist/main.js`. For Nest this is the compiled bootstrap that
   * carries the DI metadata their build emitted; for a plain-JS app it may be the
   * source itself. Missing = project not built, and the shim generation errors.
   */
  httpEntry?: string;
  /**
   * Map a source file to its runnable (built) path — the compiled provider AND
   * compiled `workers(...)` module for Nest (DI metadata intact), or the built JS
   * for any TS project. Since nothing transpiles at deploy time, every handler
   * resolves through this; a missing path means the project hasn't been built.
   */
  resolveCompiled?: (file: string) => string;
}

/**
 * Import specifier for a user's COMPILED file, resolvable at Lambda RUNTIME.
 *
 * We no longer bundle: each shim ships as `index.mjs` at the function-zip root, and
 * the user's build output is copied into that zip preserving its project-relative
 * path. So `<projectDir>/dist/main.js` deploys at `./dist/main.js` next to the shim.
 * Posix-style, and — unlike a bundler input — the `.js` extension is KEPT, because
 * Node's ESM loader requires explicit extensions on relative specifiers.
 */
function runtimeSpec(projectDir: string, compiledAbs: string): string {
  let rel = path.relative(projectDir, compiledAbs).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/**
 * A shim can only import a file the user actually built. With no bundler there's no
 * on-the-fly transpile, so every handler needs runnable output the deploy can ship:
 * the compiled JS for a TypeScript project (Nest's build also carries the DI
 * metadata we rely on), or the source itself for a plain-JS project. The caller's
 * resolver supplies that path; a missing one means the project hasn't been built.
 */
function requireCompiled(compiledAbs: string | undefined, what: string): string {
  if (!compiledAbs) {
    throw new Error(
      `Deploying ${what} needs runnable build output, but none was found. ` +
        `Build your app first (e.g. \`npm run build\`) so laranja can ship the ` +
        `compiled output.`,
    );
  }
  return compiledAbs;
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
  const resolve = (file: string) => runtimeSpec(opts.projectDir, opts.resolveCompiled!(file));
  const workersSpec = resolve(worker.handlerEntry);
  const workersImport = importBinding("workersModule", worker.appExport, workersSpec);

  // Import each provider class once, even if it hosts several methods.
  const providerImports = new Map<string, string>();
  const cronRows: string[] = [];
  const queueRows: string[] = [];
  for (const c of crons) {
    if (c.style !== "method") continue;
    providerImports.set(c.className, resolve(c.file));
    cronRows.push(`      "${c.id}": [${c.className}, "${c.method}"],`);
  }
  for (const q of queues) {
    if (q.style !== "method") continue;
    providerImports.set(q.className, resolve(q.file));
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
    const factory = isNest ? "createNestHttpHandler" : "createHttpHandler";
    const httpTarget = requireCompiled(opts.httpEntry, "the HTTP app");
    const httpSpec = runtimeSpec(opts.projectDir, httpTarget);
    const appImport = importBinding(local, ir.http.appExport, httpSpec);
    entries.push({
      id: "http",
      kind: "http",
      fileName: "http.mjs",
      handlerExport: "handler",
      contents: `${appImport}
import { ${factory} } from "@alzulejos/laranja-runtime";

export const handler = ${factory}(${local});
`,
    });
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
      fileName: `worker-${safe(w.id)}.mjs`,
      handlerExport: "handler",
      contents: workerDispatcherShim(w, crons, queues, opts),
    });
  }

  // Cron: one Lambda per STANDALONE @Cron / cron() (Express classes, or function-
  // style). Grouped Nest crons are hosted by their worker Lambda above.
  for (const cron of ir.crons) {
    if (isGrouped(cron)) continue;
    const compiled = requireCompiled(opts.resolveCompiled?.(cron.file), `cron "${cron.id}"`);
    const spec = runtimeSpec(opts.projectDir, compiled);
    const { importLine, factoryArgs } = handlerWiring(cron, spec);
    entries.push({
      id: cron.id,
      kind: "cron",
      fileName: `cron-${safe(cron.id)}.mjs`,
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
    const compiled = requireCompiled(opts.resolveCompiled?.(queue.file), `queue "${queue.id}"`);
    const spec = runtimeSpec(opts.projectDir, compiled);
    const { importLine, factoryArgs } = handlerWiring(queue, spec);
    entries.push({
      id: queue.id,
      kind: "queue",
      fileName: `queue-${safe(queue.id)}.mjs`,
      handlerExport: "handler",
      contents: `${importLine}
import { createQueueHandler } from "@alzulejos/laranja-runtime";

export const handler = createQueueHandler(${factoryArgs});
`,
    });
  }

  return entries;
}
