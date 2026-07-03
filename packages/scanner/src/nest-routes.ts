import { Node } from "ts-morph";
import type { Decorator, SourceFile } from "ts-morph";
import type { HttpRoute } from "@alzulejos/laranja-core";
import { getPropertyInitializer } from "./ast-utils.js";

/** Nest HTTP-method decorators -> the HTTP verb they map to. */
const NEST_HTTP_METHODS = new Map<string, string>([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Patch", "PATCH"],
  ["Delete", "DELETE"],
  ["Options", "OPTIONS"],
  ["Head", "HEAD"],
  ["All", "ALL"],
]);

/** Read a path string from a decorator arg: string, `["a","b"]` (first), or object `{ path }`. */
function pathArg(arg: Node | undefined): string {
  if (!arg) return "";
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.getLiteralText();
  }
  if (Node.isArrayLiteralExpression(arg)) {
    const first = arg.getElements()[0];
    if (first && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first))) {
      return first.getLiteralText();
    }
  }
  if (Node.isObjectLiteralExpression(arg)) {
    return pathArg(getPropertyInitializer(arg, "path"));
  }
  return "";
}

/** The prefix declared by `@Controller(...)` — string, array, or `{ path }` form. */
function controllerPrefix(dec: Decorator): string {
  return pathArg(dec.getArguments()[0]);
}

/** Join a controller prefix and a method sub-path into one normalized `/path`. */
function joinPath(prefix: string, sub: string): string {
  const segments = `${prefix}/${sub}`.split("/").filter(Boolean);
  return "/" + segments.join("/");
}

/**
 * Discover HTTP routes from Nest controllers for visibility/validation — the same
 * role `collectExpressRoutes` plays for Express. Reads `@Controller("prefix")` +
 * method decorators (`@Get`/`@Post`/…) and composes the full route path. Matching
 * is by decorator NAME, which is safe because this only runs for Nest projects.
 */
export function collectNestRoutes(rel: string, sf: SourceFile, routes: HttpRoute[]): void {
  for (const cls of sf.getClasses()) {
    const controller = cls.getDecorator("Controller");
    if (!controller) continue;
    const prefix = controllerPrefix(controller);

    for (const method of cls.getMethods()) {
      for (const dec of method.getDecorators()) {
        const httpMethod = NEST_HTTP_METHODS.get(dec.getName());
        if (!httpMethod) continue;
        routes.push({
          method: httpMethod,
          path: joinPath(prefix, pathArg(dec.getArguments()[0])),
          source: `${rel}:${dec.getStartLineNumber()}`,
        });
      }
    }
  }
}
