import path from "node:path";
import { azureWorkloads } from "@alzulejos/laranja-core";
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

/** Make an id safe to use as a JS identifier (file names allow `-`, identifiers don't). */
function ident(id: string): string {
  return id.replace(/[^A-Za-z0-9_$]/g, "_");
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

  // Azure deploys one package per WORKLOAD (`azureWorkloads`): the http() app plus
  // every handler needing no DI in one, and each `workers()` root in its own. Within a
  // package the Functions host discovers functions by LOADING it and reading what
  // registered as a side effect — there's no handler symbol, so `handlerExport` is
  // empty and each trigger registers itself. A project without `workers()` roots is a
  // single workload, so it emits exactly one entry, as it always did. The AWS-shaped
  // loops below skip Azure entirely.
  if (ir.app.provider === "azure") {
    const cronById = new Map(ir.crons.map((c) => [c.id, c]));
    const queueByName = new Map(ir.queues.map((q) => [q.name, q]));
    const workerById = new Map(workers.map((w) => [w.id, w]));

    /** Grouped handlers import the COMPILED provider (DI metadata intact); standalone
     *  ones need no metadata and bundle from source, as they do on AWS. */
    const handlerSpec = (h: { file: string }, isDi: boolean): string =>
      importSpecifier(opts.entryDir, isDi ? opts.resolveCompiled!(h.file) : path.join(opts.projectDir, h.file));

    for (const w of azureWorkloads(ir)) {
      const userImports = new Map<string, string>(); // importLine -> itself (dedupe)
      const runtimeImports = new Set<string>();
      const contextDecls: string[] = [];
      const registrations: string[] = [];

      // A workers() workload builds its root's DI container ONCE, memoized at module
      // scope and shared by every trigger in this package. Azure can't consolidate the
      // triggers themselves — the trigger IS the function, so five crons stay five
      // registrations — but they all run in this one app's process, so they resolve
      // against one container. That's what the AWS dispatcher buys by consolidating,
      // minus the dispatcher. Separate workloads keep roots isolated: this package
      // contains only its own module, so it can never boot another root's.
      let contextVar: string | undefined;
      if (w.workersId !== undefined) {
        const root = workerById.get(w.workersId);
        const resolve = opts.resolveCompiled;
        if (!root || !resolve) {
          throw new Error(
            `Cannot generate the Azure shim for "${w.id}": missing the compiled Nest ` +
              `build. Build your app first (e.g. \`npm run build\`).`,
          );
        }
        const moduleLocal = `workersModule_${ident(root.id)}`;
        const moduleImport = importBinding(
          moduleLocal,
          root.appExport,
          importSpecifier(opts.entryDir, resolve(root.handlerEntry)),
        );
        userImports.set(moduleImport, moduleImport);
        contextVar = `context_${ident(root.id)}`;
        runtimeImports.add("nestContext");
        contextDecls.push(
          `const ${contextVar} = nestContext(() => NestFactory.createApplicationContext(${moduleLocal}));`,
        );
      }

      /** The container a DI-bound handler resolves through. */
      const contextFor = (h: { id: string }): string => {
        if (!contextVar) throw new Error(`Internal: "${h.id}" has no workers() root to resolve against.`);
        return contextVar;
      };

      if (w.http && ir.http) {
        const httpTarget = opts.httpEntry ?? path.join(opts.projectDir, ir.http.handlerEntry);
        // Express exports a ready app instance; Nest exports an async bootstrap factory
        // and imports the COMPILED bootstrap — the same split the AWS branch makes
        // between createHttpHandler and createNestHttpHandler.
        const local = isNest ? "bootstrap" : "app";
        const register = isNest ? "registerAzureNestHttp" : "registerAzureHttp";
        const appImport = importBinding(local, ir.http.appExport, importSpecifier(opts.entryDir, httpTarget));
        userImports.set(appImport, appImport);
        runtimeImports.add(register);
        registrations.push(`${register}(${local});`);
      }
      for (const id of w.cronIds) {
        const cron = cronById.get(id);
        if (!cron) continue;
        const di = isGrouped(cron);
        const { importLine, factoryArgs } = handlerWiring(cron, handlerSpec(cron, di));
        userImports.set(importLine, importLine); // dedupe: methods on one class share an import
        const register = di ? "registerAzureNestCron" : "registerAzureCron";
        const args = di ? `${contextFor(cron)}, ${factoryArgs}` : factoryArgs;
        runtimeImports.add(register);
        registrations.push(`${register}(${JSON.stringify(cron.id)}, ${args});`);
      }
      for (const name of w.queueNames) {
        const queue = queueByName.get(name);
        if (!queue) continue;
        const di = isGrouped(queue);
        const { importLine, factoryArgs } = handlerWiring(queue, handlerSpec(queue, di));
        userImports.set(importLine, importLine);
        const register = di ? "registerAzureNestQueue" : "registerAzureQueue";
        const args = di ? `${contextFor(queue)}, ${factoryArgs}` : factoryArgs;
        runtimeImports.add(register);
        // Keyed by NAME, not id — the key the trigger binding and the producer share.
        registrations.push(`${register}(${JSON.stringify(queue.name)}, ${args});`);
      }
      // azureWorkloads only yields workloads that host something, so this holds; the
      // guard keeps the emit honest rather than shipping a package with no functions.
      if (registrations.length === 0) continue;

      // NestFactory comes from the USER's @nestjs/core, keeping this package
      // framework-agnostic — same arrangement as the AWS worker shim.
      const header = [
        contextDecls.length > 0 ? `import { NestFactory } from "@nestjs/core";` : "",
        [...userImports.keys()].join("\n"),
        `import { ${[...runtimeImports].join(", ")} } from "@alzulejos/laranja-runtime";`,
      ]
        .filter(Boolean)
        .join("\n");
      const body = [contextDecls.join("\n"), registrations.join("\n")].filter(Boolean).join("\n\n");
      entries.push({
        id: w.id,
        // The primary workload stays "http" even when it serves no http() app — it's
        // the package the app's own handlers live in, and the id/kind pair is what the
        // deploy path has always matched on.
        kind: w.workersId === undefined ? "http" : "worker",
        fileName: w.workersId === undefined ? "http.ts" : `worker-${safe(w.id)}.ts`,
        handlerExport: "",
        contents: `${header}\n\n${body}\n`,
      });
    }
  } else if (ir.http) {
    // AWS: the HTTP proxy is its own Lambda wrapping the whole app. Express exports a
    // ready app instance (createHttpHandler(app)); Nest exports an async bootstrap
    // factory (createNestHttpHandler(bootstrap)) and imports the COMPILED bootstrap.
    const local = isNest ? "bootstrap" : "app";
    const httpTarget = opts.httpEntry ?? path.join(opts.projectDir, ir.http.handlerEntry);
    const appImport = importBinding(local, ir.http.appExport, importSpecifier(opts.entryDir, httpTarget));
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

  // Worker Lambdas: one per `workers()` module, hosting all its grouped (method-
  // style) crons + queues behind a single dispatcher. This is where bundle
  // duplication disappears — the module's DI graph is bundled once, not per handler.
  // Azure needs no dispatcher: its grouped handlers already registered above against
  // a shared per-root context, inside the one package. Skipping keeps it at ONE asset.
  for (const w of workers) {
    if (ir.app.provider === "azure") break;
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
  // queues are hosted by their worker Lambda above. Azure has no per-queue entry —
  // its queues are folded into the one app package in the http branch above — so
  // this AWS-shaped loop skips them (mirrors the cron loop).
  for (const queue of ir.queues) {
    if (ir.app.provider === "azure") break;
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
