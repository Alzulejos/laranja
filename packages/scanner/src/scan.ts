import path from "node:path";
import { existsSync } from "node:fs";
import { Project, Node } from "ts-morph";
import type { ClassDeclaration, MethodDeclaration, SourceFile } from "ts-morph";
import {
  assertSchedule,
  intervalToSchedule,
  type ComputeConfig,
  type CronIR,
  type Framework,
  type HttpIR,
  type HttpRoute,
  type InfraIR,
  type LaranjaConfig,
  type QueueIR,
  type ResourceConfig,
} from "@alzulejos/laranja-core";
import { getPropertyInitializer, literalValue, readDecoratorArg, resolveScheduleNode } from "./ast-utils.js";
import { detectFramework } from "./detect.js";
import { collectNestRoutes } from "./nest-routes.js";

export interface ScanInput {
  projectDir: string;
  config: LaranjaConfig & { env: Record<string, string> };
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);

/**
 * Statically scans the user's project and produces the Infra IR.
 * No user code is executed — this is pure AST analysis.
 */
export function scan({ projectDir, config }: ScanInput): InfraIR {
  const framework: Framework = config.framework ?? detectFramework(projectDir);

  const project = new Project({
    // Skip type-checking deps: we only need syntax, so the user's node_modules
    // don't have to be installed for a scan to work. allowJs lets plain JS apps
    // use the same code-first markers (cron/queue/http) and route discovery.
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  // TS and JS, every module flavour. Skip the obvious non-source trees so the
  // root `**` fallback doesn't drag in node_modules / our own generated entries.
  const ext = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
  const ignore = [
    `!${path.join(projectDir, "**/node_modules/**")}`,
    `!${path.join(projectDir, "**/.laranja/**")}`,
    `!${path.join(projectDir, "**/dist/**")}`,
    `!${path.join(projectDir, "**/cdk.out/**")}`,
  ];
  project.addSourceFilesAtPaths([
    path.join(projectDir, `src/**/*.${ext}`),
    ...ignore,
  ]);
  if (project.getSourceFiles().length === 0) {
    project.addSourceFilesAtPaths([
      path.join(projectDir, `**/*.${ext}`),
      ...ignore,
    ]);
  }

  const crons: CronIR[] = [];
  const queues: QueueIR[] = [];
  const routes: HttpRoute[] = [];
  const httpMarkers: CallMarker[] = [];
  const workerMarkers: CallMarker[] = [];
  const envKeys = new Set<string>();

  for (const sf of project.getSourceFiles()) {
    const rel = path.relative(projectDir, sf.getFilePath());
    if (rel.includes("node_modules")) continue;

    for (const cls of sf.getClasses()) {
      for (const method of cls.getMethods()) {
        collectFromMethod(rel, cls, method, crons, queues);
      }
    }

    const regImports = registrationImports(sf);
    if (regImports.size > 0) {
      collectFromRegistrations(rel, sf, regImports, crons, queues);
    }

    collectEnvKeys(sf, envKeys);

    if (framework === "express") {
      collectExpressRoutes(rel, sf, routes);
    } else if (framework === "nest") {
      collectNestRoutes(rel, sf, routes);
    }
    collectCallMarkers(rel, sf, "http", httpMarkers);
    collectCallMarkers(rel, sf, "workers", workerMarkers);
  }

  // The HTTP app is declared solely by the code `http()` marker. One marker → an
  // HTTP app; no marker → workers-only. There's no config flag either way.
  let http: HttpIR | undefined;
  if (httpMarkers.length > 1) {
    throw new Error(
      `Found ${httpMarkers.length} http() markers (${httpMarkers
        .map((m) => m.source)
        .join(", ")}). There can be only one HTTP app per project.`,
    );
  }
  const marker = httpMarkers[0];
  if (marker) {
    http = { handlerEntry: marker.file, appExport: marker.appExport, routes };
  }

  if (http === undefined && crons.length === 0 && queues.length === 0) {
    throw new Error(
      `Nothing to deploy: no HTTP app (wrap and export your app with http(app)) ` +
        `and no @Cron/@Queue or cron()/queue() handlers were found.`,
    );
  }

  // The workers() marker names the Nest module we build a DI context from, so each
  // class-based (@Cron/@Queue on a provider) worker resolves through real DI instead
  // of `new`. One marker per project.
  if (workerMarkers.length > 1) {
    throw new Error(
      `Found ${workerMarkers.length} workers() markers (${workerMarkers
        .map((m) => m.source)
        .join(", ")}). There can be only one workers module per project.`,
    );
  }
  const workerMarker = workerMarkers[0];
  const workers = workerMarker
    ? { handlerEntry: workerMarker.file, appExport: workerMarker.appExport }
    : undefined;

  // Nest resolves method-style workers through DI, which needs that module. (Plain
  // function-style cron()/queue() handlers don't — they're standalone functions.)
  if (framework === "nest" && !workers) {
    const needsDi = [...crons, ...queues].find((h) => h.style === "method");
    if (needsDi) {
      throw new Error(
        `${needsDi.source}: a Nest @Cron/@Queue on a class needs its dependency-injection graph. ` +
          `Export it once with workers(AppModule), e.g. \`export default workers(AppModule)\`.`,
      );
    }
  }

  // Validate `resources` keys against the resources we actually found, then merge
  // global `compute` defaults with each per-resource override and attach the
  // result to the IR. An unknown key is a typo — fail loudly rather than no-op.
  // Resource keys: http -> "http", cron -> its id, queue -> its NAME (what the
  // user wrote in @Queue/queue() — the natural handle, and what a DLQ references).
  // They share one namespace, so reject collisions before anything references them.
  assertUniqueResourceKeys(http, crons, queues);
  validateResourceKeys(config, http, crons, queues);
  const queueNames = new Set(queues.map((q) => q.name));
  if (http) {
    http.compute = resolveCompute(config, "http");
    rejectForeignKeys("http", "http app", config.resources?.["http"], COMPUTE_KEYS);
  }
  for (const c of crons) {
    c.compute = resolveCompute(config, c.id);
    applyCronConfig(c, config.resources?.[c.id], queueNames);
  }
  for (const q of queues) {
    q.compute = resolveCompute(config, q.name);
    applyQueueConfig(q, config.resources?.[q.name], queueNames);
  }

  const stage = config.stage ?? "dev";
  const provider = config.provider ?? "aws";

  return {
    app: { name: config.name, framework, provider, stage, entry: http?.handlerEntry },
    http,
    workers,
    crons,
    queues,
    // STAGE is always available at runtime, overridable via explicit env.
    env: { STAGE: stage, ...config.env },
    // Names only — values are resolved client-side at deploy time.
    envKeys: [...envKeys].sort(),
  };
}

function loc(rel: string, node: Node): string {
  return `${rel}:${node.getStartLineNumber()}`;
}

/**
 * Pick only the compute fields from a config block, dropping `undefined` so they
 * never clobber a lower-precedence value during the merge. Done by explicit field
 * list (not a blind spread) so future resource-specific keys in `ResourceConfig`
 * don't leak into the compute IR.
 */
function pickCompute(src: ComputeConfig | undefined): ComputeConfig {
  const out: ComputeConfig = {};
  if (!src) return out;
  if (src.memory !== undefined) out.memory = src.memory;
  if (src.timeout !== undefined) out.timeout = src.timeout;
  if (src.maxConcurrency !== undefined) out.maxConcurrency = src.maxConcurrency;
  if (src.architecture !== undefined) out.architecture = src.architecture;
  if (src.logRetention !== undefined) out.logRetention = src.logRetention;
  return out;
}

/** Merge global `compute` defaults with a resource's override; override wins per field. */
function resolveCompute(config: ScanInput["config"], id: string): ComputeConfig | undefined {
  const merged = { ...pickCompute(config.compute), ...pickCompute(config.resources?.[id]) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Every `resources` key must name a real resource — a typo'd id is a hard error. */
function validateResourceKeys(
  config: ScanInput["config"],
  http: HttpIR | undefined,
  crons: CronIR[],
  queues: QueueIR[],
): void {
  if (!config.resources) return;
  const validIds = new Set<string>([
    ...(http ? ["http"] : []),
    ...crons.map((c) => c.id),
    ...queues.map((q) => q.name),
  ]);
  for (const key of Object.keys(config.resources)) {
    if (!validIds.has(key)) {
      const known = [...validIds].sort().join(", ") || "(none)";
      throw new Error(
        `laranja.config.ts: resources["${key}"] doesn't match any resource. Known ids: ${known}.`,
      );
    }
  }
}

/**
 * http ("http"), crons (their id), and queues (their name) all live in one
 * resource-key namespace — used by `resources` overrides and DLQ references. A
 * collision (two queues named the same, or a queue name equal to a cron id) would
 * make a key ambiguous, so reject it early with a clear message rather than let
 * CloudFormation fail on a duplicate physical name later.
 */
function assertUniqueResourceKeys(http: HttpIR | undefined, crons: CronIR[], queues: QueueIR[]): void {
  const seen = new Map<string, string>();
  const claim = (key: string, what: string): void => {
    const prev = seen.get(key);
    if (prev) {
      throw new Error(`laranja.config.ts: resource id "${key}" is used by both ${prev} and ${what} — ids must be unique.`);
    }
    seen.set(key, what);
  };
  if (http) claim("http", "the HTTP app");
  for (const c of crons) claim(c.id, `cron "${c.id}"`);
  for (const q of queues) claim(q.name, `queue "${q.name}"`);
}

/** Default consumer timeout (seconds); mirrors the back-half so validation matches. */
const DEFAULT_CONSUMER_TIMEOUT = 30;

const COMPUTE_KEYS = new Set(["memory", "timeout", "maxConcurrency", "architecture", "logRetention"]);
const QUEUE_KEYS = new Set([
  "contentBasedDedup",
  "visibilityTimeout",
  "maxBatchingWindow",
  "reportBatchItemFailures",
  "messageRetention",
  "dlq",
]);
const CRON_KEYS = new Set(["timezone", "retryAttempts", "maxEventAge", "dlq"]);

/** Reject any override key that doesn't apply to this resource's kind. */
function rejectForeignKeys(
  id: string,
  kind: string,
  override: ResourceConfig | undefined,
  ...allowed: Set<string>[]
): void {
  if (!override) return;
  for (const key of Object.keys(override)) {
    if (!allowed.some((set) => set.has(key))) {
      throw new Error(`laranja.config.ts: resources["${id}"].${key} is not valid for a ${kind}.`);
    }
  }
}

/** Apply a cron's per-resource override (timezone, async retry, DLQ) onto its IR. */
function applyCronConfig(c: CronIR, override: ResourceConfig | undefined, queueNames: Set<string>): void {
  if (!override) return;
  rejectForeignKeys(c.id, "cron", override, COMPUTE_KEYS, CRON_KEYS);
  if (override.timezone !== undefined) c.timezone = override.timezone;
  if (override.retryAttempts !== undefined) {
    if (override.retryAttempts < 0 || override.retryAttempts > 2) {
      throw new Error(`laranja.config.ts: resources["${c.id}"].retryAttempts must be between 0 and 2.`);
    }
    c.retryAttempts = override.retryAttempts;
  }
  if (override.maxEventAge !== undefined) c.maxEventAge = override.maxEventAge;
  if (override.dlq) {
    assertDlqTarget(c.id, override.dlq.queue, queueNames);
    c.dlq = { queue: override.dlq.queue };
  }
}

/** Apply a queue's per-resource override (SQS + event-source knobs, DLQ) onto its IR. */
function applyQueueConfig(q: QueueIR, override: ResourceConfig | undefined, queueNames: Set<string>): void {
  if (!override) return;
  rejectForeignKeys(q.name, "queue", override, COMPUTE_KEYS, QUEUE_KEYS);
  if (override.contentBasedDedup !== undefined) {
    if (!q.fifo) {
      throw new Error(`laranja.config.ts: resources["${q.name}"].contentBasedDedup is FIFO-only.`);
    }
    q.contentBasedDedup = override.contentBasedDedup;
  }
  if (override.maxBatchingWindow !== undefined) q.maxBatchingWindow = override.maxBatchingWindow;
  if (override.reportBatchItemFailures !== undefined) q.reportBatchItemFailures = override.reportBatchItemFailures;
  if (override.messageRetention !== undefined) q.messageRetention = override.messageRetention;
  if (override.visibilityTimeout !== undefined) {
    const timeout = q.compute?.timeout ?? DEFAULT_CONSUMER_TIMEOUT;
    if (override.visibilityTimeout < timeout) {
      throw new Error(
        `laranja.config.ts: resources["${q.name}"].visibilityTimeout (${override.visibilityTimeout}s) ` +
          `must be >= the consumer timeout (${timeout}s).`,
      );
    }
    q.visibilityTimeout = override.visibilityTimeout;
  }
  if (override.dlq) {
    if (override.dlq.maxReceiveCount === undefined) {
      throw new Error(`laranja.config.ts: resources["${q.name}"].dlq requires maxReceiveCount.`);
    }
    assertDlqTarget(q.name, override.dlq.queue, queueNames);
    q.dlq = { maxReceiveCount: override.dlq.maxReceiveCount, queue: override.dlq.queue };
  }
}

/** A DLQ target must be another declared queue (by name) — never missing, never itself. */
function assertDlqTarget(key: string, target: string, queueNames: Set<string>): void {
  if (target === key) {
    throw new Error(`laranja.config.ts: resources["${key}"].dlq.queue cannot be the queue itself.`);
  }
  if (!queueNames.has(target)) {
    const known = [...queueNames].sort().join(", ") || "(none)";
    throw new Error(
      `laranja.config.ts: resources["${key}"].dlq.queue "${target}" is not a declared queue. Queues: ${known}.`,
    );
  }
}

/**
 * Resolve a queue's physical name + fifo flag, enforcing AWS's ".fifo" suffix rule.
 * A `.fifo` suffix or `fifo: true` marks a FIFO queue; when `fifo: true` is set but
 * the name lacks the suffix, append it so the deploy doesn't fail with CDK's
 * cryptic `FifoQueueNames` error. The normalized name surfaces in `plan`.
 */
function resolveQueueName(rawName: string, fifoOpt: unknown): { name: string; fifo: boolean } {
  const fifo = fifoOpt === true || rawName.endsWith(".fifo");
  const name = fifo && !rawName.endsWith(".fifo") ? `${rawName}.fifo` : rawName;
  return { name, fifo };
}

function collectFromMethod(
  rel: string,
  cls: ClassDeclaration,
  method: MethodDeclaration,
  crons: CronIR[],
  queues: QueueIR[],
): void {
  const className = cls.getName() ?? "(anonymous)";
  const methodName = method.getName();

  for (const dec of method.getDecorators()) {
    const name = dec.getName();

    if (name === "Cron") {
      const where = loc(rel, dec);
      const args = dec.getArguments();
      const argNode = args[0];

      // One decorator name, two call shapes:
      //   laranja:        @Cron(<schedule>)            @Cron({ schedule, id })
      //   @nestjs/schedule: @Cron(<expr>, { name, timeZone })  (expr = string | CronExpression)
      let scheduleNode: Node | undefined = argNode;
      let explicitId: string | undefined;
      let timezone: string | undefined;
      if (argNode && Node.isObjectLiteralExpression(argNode)) {
        scheduleNode = getPropertyInitializer(argNode, "schedule");
        const idInit = getPropertyInitializer(argNode, "id");
        explicitId = idInit && Node.isStringLiteral(idInit) ? idInit.getLiteralText() : undefined;
      } else {
        // Nest's options object is the SECOND argument: name -> id, timeZone -> timezone.
        const optNode = args[1];
        if (optNode && Node.isObjectLiteralExpression(optNode)) {
          const nameInit = getPropertyInitializer(optNode, "name");
          if (nameInit && Node.isStringLiteral(nameInit)) explicitId = nameInit.getLiteralText();
          const tzInit = getPropertyInitializer(optNode, "timeZone");
          if (tzInit && Node.isStringLiteral(tzInit)) timezone = tzInit.getLiteralText();
        }
      }

      const schedule = resolveScheduleNode(scheduleNode, where);
      if (!schedule) {
        throw new Error(
          `@Cron at ${where}: could not resolve a valid static schedule. ` +
            `Use rate(n, unit), every(unit), a "rate(...)"/"cron(...)" string, ` +
            `a node-cron expression, or CronExpression.* with literal arguments.`,
        );
      }
      assertSchedule(schedule, where);

      crons.push({
        style: "method",
        id: explicitId ?? `${className}-${methodName}`,
        schedule,
        ...(timezone ? { timezone } : {}),
        file: rel,
        className,
        method: methodName,
        source: loc(rel, method),
      });
    }

    if (name === "Interval") {
      const where = loc(rel, dec);
      const args = dec.getArguments();
      // @Interval(ms) or @Interval("name", ms) — Nest's signature.
      const hasName = args.length >= 2;
      const explicitId = hasName && Node.isStringLiteral(args[0]) ? args[0].getLiteralText() : undefined;
      const ms = literalValue(hasName ? args[1] : args[0]);
      if (typeof ms !== "number") {
        throw new Error(`@Interval at ${where}: the interval must be a numeric millisecond literal.`);
      }
      crons.push({
        style: "method",
        id: explicitId ?? `${className}-${methodName}`,
        schedule: intervalToSchedule(ms, where),
        file: rel,
        className,
        method: methodName,
        source: loc(rel, method),
      });
    }

    if (name === "Timeout") {
      throw new Error(
        `@Timeout at ${loc(rel, dec)}: one-shot @Timeout jobs have no serverless equivalent ` +
          `(they fire once relative to a process start that doesn't exist on Lambda). Use @Cron or @Interval.`,
      );
    }

    if (name === "Queue") {
      const arg = readDecoratorArg(dec.getArguments()[0]);
      if (arg.kind !== "object" || !arg.value.name) continue;
      const { name: queueName, fifo } = resolveQueueName(String(arg.value.name), arg.value.fifo);
      queues.push({
        style: "method",
        id: `${className}-${methodName}`,
        name: queueName,
        batchSize: typeof arg.value.batchSize === "number" ? arg.value.batchSize : undefined,
        fifo,
        file: rel,
        className,
        method: methodName,
        source: loc(rel, method),
      });
    }
  }
}

/** Modules whose `cron`/`queue` exports are laranja's function-style markers. */
const REGISTRATION_MODULES = new Set(["@alzulejos/laranja-decorators", "@alzulejos/laranja-core"]);

/**
 * Map a file's local identifiers to the laranja marker they're bound to, honoring
 * aliases — e.g. `import { cron as schedule } from "@alzulejos/laranja-decorators"`.
 */
function registrationImports(sf: SourceFile): Map<string, "cron" | "queue"> {
  const map = new Map<string, "cron" | "queue">();
  for (const imp of sf.getImportDeclarations()) {
    if (!REGISTRATION_MODULES.has(imp.getModuleSpecifierValue())) continue;
    for (const named of imp.getNamedImports()) {
      const imported = named.getName();
      if (imported === "cron" || imported === "queue") {
        map.set(named.getAliasNode()?.getText() ?? imported, imported);
      }
    }
  }
  return map;
}

/**
 * Resolve the handler argument of a `cron()`/`queue()` call to an exported
 * function name in the same file — the shim imports it by name, so it must be a
 * named, exported function (or exported `const`).
 */
function resolveExportedHandlerName(sf: SourceFile, argNode: Node | undefined, where: string): string {
  if (!argNode || !Node.isIdentifier(argNode)) {
    throw new Error(
      `Registration at ${where}: the handler must be a reference to a named, exported function ` +
        `(e.g. \`cron(rate(5, "minutes"), refreshCache)\`).`,
    );
  }
  const name = argNode.getText();

  const fn = sf.getFunction(name);
  if (fn) {
    if (!fn.isExported()) {
      throw new Error(`Registration at ${where}: function "${name}" must be exported so laranja can import it.`);
    }
    return name;
  }

  const varDecl = sf.getVariableDeclaration(name);
  if (varDecl) {
    if (!varDecl.getVariableStatement()?.isExported()) {
      throw new Error(`Registration at ${where}: "${name}" must be exported so laranja can import it.`);
    }
    return name;
  }

  throw new Error(
    `Registration at ${where}: could not find "${name}" in this file. ` +
      `Define and export the handler alongside the cron()/queue() call.`,
  );
}

/** Discover module-level `cron(...)` / `queue(...)` marker calls (function style). */
function collectFromRegistrations(
  rel: string,
  sf: SourceFile,
  imports: Map<string, "cron" | "queue">,
  crons: CronIR[],
  queues: QueueIR[],
): void {
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee)) return;
    const kind = imports.get(callee.getText());
    if (!kind) return;

    const where = loc(rel, node);
    const args = node.getArguments();

    if (kind === "cron") {
      const optNode = args[0];
      let scheduleNode: Node | undefined = optNode;
      let explicitId: string | undefined;
      if (optNode && Node.isObjectLiteralExpression(optNode)) {
        scheduleNode = getPropertyInitializer(optNode, "schedule");
        const idInit = getPropertyInitializer(optNode, "id");
        explicitId = idInit && Node.isStringLiteral(idInit) ? idInit.getLiteralText() : undefined;
      }
      const schedule = resolveScheduleNode(scheduleNode, where);
      if (!schedule) {
        throw new Error(
          `cron() at ${where}: could not resolve a valid static schedule. ` +
            `Use rate(n, unit), every(unit), a "rate(...)"/"cron(...)" string, ` +
            `a node-cron expression, or CronExpression.* with literal arguments.`,
        );
      }
      assertSchedule(schedule, where);
      const exportName = resolveExportedHandlerName(sf, args[1], where);
      crons.push({ style: "function", id: explicitId ?? exportName, schedule, file: rel, exportName, source: where });
      return;
    }

    // queue
    const arg = readDecoratorArg(args[0]);
    if (arg.kind !== "object" || !arg.value.name) {
      throw new Error(`queue() at ${where}: requires an options object with a "name".`);
    }
    const { name: queueName, fifo } = resolveQueueName(String(arg.value.name), arg.value.fifo);
    const exportName = resolveExportedHandlerName(sf, args[1], where);
    queues.push({
      style: "function",
      id: exportName,
      name: queueName,
      batchSize: typeof arg.value.batchSize === "number" ? arg.value.batchSize : undefined,
      fifo,
      file: rel,
      exportName,
      source: where,
    });
  });
}

/** A discovered call-marker (`http(app)` / `workers(AppModule)`): its file + bound export. */
interface CallMarker {
  file: string;
  appExport: string;
  source: string;
}

/** Local identifiers in this file bound to a given laranja marker (alias-aware). */
function markerNames(sf: SourceFile, marker: string): Set<string> {
  const names = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    if (!REGISTRATION_MODULES.has(imp.getModuleSpecifierValue())) continue;
    for (const named of imp.getNamedImports()) {
      if (named.getName() === marker) names.add(named.getAliasNode()?.getText() ?? marker);
    }
  }
  return names;
}

/**
 * Discover a call-marker (`http(app)` / `workers(AppModule)`). The marker must be
 * bound to an export so the shim can import it — either `export default m(x)` or
 * `export const y = m(x)`.
 */
function collectCallMarkers(rel: string, sf: SourceFile, marker: string, markers: CallMarker[]): void {
  const names = markerNames(sf, marker);
  if (names.size === 0) return;

  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee) || !names.has(callee.getText())) return;

    const where = loc(rel, node);
    const parent = node.getParent();

    if (parent && Node.isExportAssignment(parent)) {
      markers.push({ file: rel, appExport: "default", source: where });
      return;
    }
    if (parent && Node.isVariableDeclaration(parent)) {
      if (!parent.getVariableStatement()?.isExported()) {
        throw new Error(`${marker}() at ${where}: the value must be exported, e.g. \`export const x = ${marker}(...)\`.`);
      }
      markers.push({ file: rel, appExport: parent.getName(), source: where });
      return;
    }
    throw new Error(
      `${marker}() at ${where}: wrap and export it, e.g. \`export default ${marker}(...)\` ` +
        `or \`export const x = ${marker}(...)\`.`,
    );
  });
}

/** Best-effort discovery of `app.get("/path", ...)` style routes for visibility. */
function collectExpressRoutes(rel: string, sf: SourceFile, routes: HttpRoute[]): void {
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    const methodName = expr.getName().toLowerCase();
    if (!HTTP_METHODS.has(methodName)) return;
    const firstArg = node.getArguments()[0];
    if (!firstArg || !(Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg))) return;
    routes.push({
      method: methodName.toUpperCase(),
      path: firstArg.getLiteralText(),
      source: loc(rel, node),
    });
  });
}

/** Local identifiers in this file bound to laranja's `env` helper (alias-aware). */
function envHelperNames(sf: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    if (!REGISTRATION_MODULES.has(imp.getModuleSpecifierValue())) continue;
    for (const named of imp.getNamedImports()) {
      if (named.getName() === "env") names.add(named.getAliasNode()?.getText() ?? "env");
    }
  }
  return names;
}

/**
 * Discover `env("NAME")` calls and collect the declared variable NAMES. The
 * argument must be a string literal — `env(someVar)` is intentionally ignored
 * (we can't know the name statically; this keeps env discovery deterministic and
 * auditable). Location is irrelevant: a call buried in a handler body counts the
 * same as one at module scope, because this is pure source analysis.
 */
function collectEnvKeys(sf: SourceFile, keys: Set<string>): void {
  const names = envHelperNames(sf);
  if (names.size === 0) return;

  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee) || !names.has(callee.getText())) return;
    const arg = node.getArguments()[0];
    if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      keys.add(arg.getLiteralText());
    }
  });
}
