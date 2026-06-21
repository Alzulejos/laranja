import path from "node:path";
import { existsSync } from "node:fs";
import { Project, Node } from "ts-morph";
import type { ClassDeclaration, MethodDeclaration, SourceFile } from "ts-morph";
import {
  assertSchedule,
  type CronIR,
  type Framework,
  type HttpIR,
  type HttpRoute,
  type InfraIR,
  type LaranjaConfig,
  type QueueIR,
} from "@laranja/core";
import { getPropertyInitializer, readDecoratorArg, resolveScheduleNode } from "./ast-utils.js";
import { detectFramework } from "./detect.js";

export interface ScanInput {
  projectDir: string;
  config: LaranjaConfig & { appExport: string; env: Record<string, string> };
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
    // don't have to be installed for a scan to work.
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  const srcGlob = path.join(projectDir, "src/**/*.ts");
  project.addSourceFilesAtPaths(srcGlob);
  if (project.getSourceFiles().length === 0) {
    project.addSourceFilesAtPaths(path.join(projectDir, "**/*.ts"));
  }

  // `http: false` is an explicit opt-out — a workers-only deployment, no marker
  // detection, no config fallback.
  const httpDisabled = config.http === false;

  const crons: CronIR[] = [];
  const queues: QueueIR[] = [];
  const routes: HttpRoute[] = [];
  const httpMarkers: HttpMarker[] = [];
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
    }
    if (!httpDisabled) {
      collectHttpMarkers(rel, sf, httpMarkers);
    }
  }

  // Resolve the HTTP app: explicit `http: false` wins, then a code `http()`
  // marker, then the config `entry`/`appExport` fallback.
  let http: HttpIR | undefined;
  if (!httpDisabled) {
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
    } else if (config.entry) {
      http = { handlerEntry: config.entry, appExport: config.appExport, routes };
    }
  }

  if (http === undefined && crons.length === 0 && queues.length === 0) {
    throw new Error(
      `Nothing to deploy: no HTTP app (no http() marker or "entry", or "http: false") ` +
        `and no @Cron/@Queue or cron()/queue() handlers were found.`,
    );
  }

  const stage = config.stage ?? "dev";
  const provider = config.provider ?? "aws";

  return {
    app: { name: config.name, framework, provider, stage, entry: http?.handlerEntry },
    http,
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
      const argNode = dec.getArguments()[0];

      // @Cron(<schedule>) or @Cron({ schedule, id })
      let scheduleNode: Node | undefined = argNode;
      let explicitId: string | undefined;
      if (argNode && Node.isObjectLiteralExpression(argNode)) {
        scheduleNode = getPropertyInitializer(argNode, "schedule");
        const idInit = getPropertyInitializer(argNode, "id");
        const idVal = idInit && Node.isStringLiteral(idInit) ? idInit.getLiteralText() : undefined;
        explicitId = idVal;
      }

      const schedule = resolveScheduleNode(scheduleNode);
      if (!schedule) {
        throw new Error(
          `@Cron at ${where}: could not resolve a valid static schedule. ` +
            `Use rate(n, unit), every(unit), or a raw "rate(...)"/"cron(...)" string with literal arguments.`,
        );
      }
      assertSchedule(schedule, where);

      crons.push({
        style: "method",
        id: explicitId ?? `${className}-${methodName}`,
        schedule,
        file: rel,
        className,
        method: methodName,
        source: loc(rel, method),
      });
    }

    if (name === "Queue") {
      const arg = readDecoratorArg(dec.getArguments()[0]);
      if (arg.kind !== "object" || !arg.value.name) continue;
      const queueName = String(arg.value.name);
      queues.push({
        style: "method",
        id: `${className}-${methodName}`,
        name: queueName,
        batchSize: typeof arg.value.batchSize === "number" ? arg.value.batchSize : undefined,
        fifo: arg.value.fifo === true || queueName.endsWith(".fifo"),
        file: rel,
        className,
        method: methodName,
        source: loc(rel, method),
      });
    }
  }
}

/** Modules whose `cron`/`queue` exports are laranja's function-style markers. */
const REGISTRATION_MODULES = new Set(["@laranja/decorators", "@laranja/core"]);

/**
 * Map a file's local identifiers to the laranja marker they're bound to, honoring
 * aliases — e.g. `import { cron as schedule } from "@laranja/decorators"`.
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
      const schedule = resolveScheduleNode(scheduleNode);
      if (!schedule) {
        throw new Error(
          `cron() at ${where}: could not resolve a valid static schedule. ` +
            `Use rate(n, unit), every(unit), or a raw "rate(...)"/"cron(...)" string with literal arguments.`,
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
    const queueName = String(arg.value.name);
    const exportName = resolveExportedHandlerName(sf, args[1], where);
    queues.push({
      style: "function",
      id: exportName,
      name: queueName,
      batchSize: typeof arg.value.batchSize === "number" ? arg.value.batchSize : undefined,
      fifo: arg.value.fifo === true || queueName.endsWith(".fifo"),
      file: rel,
      exportName,
      source: where,
    });
  });
}

/** A discovered `http(app)` marker: the file it lives in and the export it's bound to. */
interface HttpMarker {
  file: string;
  appExport: string;
  source: string;
}

/** Local identifiers in this file bound to laranja's `http` marker (alias-aware). */
function httpMarkerNames(sf: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    if (!REGISTRATION_MODULES.has(imp.getModuleSpecifierValue())) continue;
    for (const named of imp.getNamedImports()) {
      if (named.getName() === "http") names.add(named.getAliasNode()?.getText() ?? "http");
    }
  }
  return names;
}

/**
 * Discover `http(app)` markers. The marker must be bound to an export so the shim
 * can import it — either `export default http(app)` or `export const x = http(app)`.
 */
function collectHttpMarkers(rel: string, sf: SourceFile, markers: HttpMarker[]): void {
  const names = httpMarkerNames(sf);
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
        throw new Error(`http() at ${where}: the app must be exported, e.g. \`export const app = http(app)\`.`);
      }
      markers.push({ file: rel, appExport: parent.getName(), source: where });
      return;
    }
    throw new Error(
      `http() at ${where}: wrap and export the app, e.g. \`export default http(app)\` ` +
        `or \`export const app = http(app)\`.`,
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
