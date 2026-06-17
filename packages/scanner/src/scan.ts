import path from "node:path";
import { existsSync } from "node:fs";
import { Project, Node } from "ts-morph";
import type { ClassDeclaration, MethodDeclaration, SourceFile } from "ts-morph";
import {
  assertScheduleExpression,
  type CronIR,
  type Framework,
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

  // `http: false` opts out of the HTTP proxy — a workers-only deployment.
  const httpEnabled = config.http !== false;

  const crons: CronIR[] = [];
  const queues: QueueIR[] = [];
  const routes: HttpRoute[] = [];

  for (const sf of project.getSourceFiles()) {
    const rel = path.relative(projectDir, sf.getFilePath());
    if (rel.includes("node_modules")) continue;

    for (const cls of sf.getClasses()) {
      for (const method of cls.getMethods()) {
        collectFromMethod(rel, cls, method, crons, queues);
      }
    }

    if (httpEnabled && framework === "express") {
      collectExpressRoutes(rel, sf, routes);
    }
  }

  if (httpEnabled && !config.entry) {
    throw new Error(`Cannot scan HTTP app: "entry" is required (or set "http: false").`);
  }
  if (!httpEnabled && crons.length === 0 && queues.length === 0) {
    throw new Error(`Nothing to deploy: "http" is false and no @Cron or @Queue handlers were found.`);
  }

  const stage = config.stage ?? "dev";

  return {
    app: { name: config.name, framework, stage, entry: httpEnabled ? config.entry : undefined },
    http: httpEnabled
      ? { handlerEntry: config.entry!, appExport: config.appExport, routes }
      : undefined,
    crons,
    queues,
    // STAGE is always available at runtime, overridable via explicit env.
    env: { STAGE: stage, ...config.env },
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
          `@Cron at ${where}: could not resolve a static schedule. ` +
            `Use a string, rate(n, unit), or every(unit) with literal arguments.`,
        );
      }
      assertScheduleExpression(schedule, where);

      crons.push({
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
