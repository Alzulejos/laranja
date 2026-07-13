import { Node, SyntaxKind } from "ts-morph";
import type { ObjectLiteralExpression } from "ts-morph";
import {
  rate,
  every,
  parseScheduleString,
  nestCronToSchedule,
  CRON_EXPRESSION_VALUES,
  type RateUnit,
  type Schedule,
} from "@alzulejos/laranja-core";

/** Resolve a literal AST node to a plain JS value, or undefined if not a literal. */
export function literalValue(node: Node | undefined): string | number | boolean | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  if (Node.isNumericLiteral(node)) return Number(node.getLiteralText());
  if (node.getKind() === SyntaxKind.TrueKeyword) return true;
  if (node.getKind() === SyntaxKind.FalseKeyword) return false;
  return undefined;
}

/** Flatten an object literal's simple property assignments into a record. */
export function objectToRecord(obj: ObjectLiteralExpression): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      out[prop.getName()] = literalValue(prop.getInitializer());
    }
  }
  return out;
}

const RATE_UNITS = new Set<string>(["minute", "minutes", "hour", "hours", "day", "days"]);

/**
 * Constant-fold a call to laranja's own `rate(...)`/`every(...)` helpers using
 * literal arguments. Returns the neutral structured Schedule, or undefined if
 * the call isn't a recognized helper or its args aren't literals.
 */
export function foldScheduleCall(node: Node | undefined): Schedule | undefined {
  if (!node || !Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  if (!Node.isIdentifier(callee)) return undefined;
  const name = callee.getText();
  const args = node.getArguments().map((a) => literalValue(a));

  if (name === "rate" && typeof args[0] === "number" && typeof args[1] === "string" && RATE_UNITS.has(args[1])) {
    try {
      return rate(args[0], args[1] as RateUnit);
    } catch {
      return undefined;
    }
  }
  if (name === "every" && (args[0] === "minute" || args[0] === "hour" || args[0] === "day")) {
    return every(args[0]);
  }
  return undefined;
}

/**
 * Resolve a `CronExpression.MEMBER` reference to its node-cron string, matching on
 * the object identifier name (`CronExpression`) and a known member. Alias-agnostic:
 * whether the enum is imported from laranja or `@nestjs/schedule`, the member names
 * and values are identical, so we fold through our own mirror.
 */
function resolveCronExpressionMember(node: Node): string | undefined {
  if (!Node.isPropertyAccessExpression(node)) return undefined;
  const obj = node.getExpression();
  if (!Node.isIdentifier(obj) || obj.getText() !== "CronExpression") return undefined;
  return CRON_EXPRESSION_VALUES[node.getName()];
}

/**
 * Resolve a node used as a schedule into the neutral structured Schedule. Accepts,
 * in order: a `rate(...)`/`every(...)` helper call; a `CronExpression.MEMBER`
 * reference; a raw AWS `rate(...)`/`cron(...)` string; or a bare node-cron string
 * (the `@nestjs/schedule` form, translated to the AWS dialect — which THROWS a
 * located error for anything EventBridge can't honor). Returns undefined only for
 * non-static input (e.g. a variable), so callers can raise a "not static" error.
 */
export function resolveScheduleNode(node: Node | undefined, where: string): Schedule | undefined {
  if (!node) return undefined;

  const folded = foldScheduleCall(node);
  if (folded) return folded;

  const enumExpr = resolveCronExpressionMember(node);
  if (enumExpr !== undefined) return nestCronToSchedule(enumExpr, where);

  const lit = literalValue(node);
  if (typeof lit === "string") {
    // A wrapped AWS string (`rate(...)`/`cron(...)`) is the native form; anything
    // else that's a string is treated as a node-cron expression and translated.
    return parseScheduleString(lit) ?? nestCronToSchedule(lit, where);
  }
  return undefined;
}

/** Return the initializer node of a named property on an object literal. */
export function getPropertyInitializer(obj: ObjectLiteralExpression, name: string): Node | undefined {
  const prop = obj.getProperty(name);
  if (prop && Node.isPropertyAssignment(prop)) return prop.getInitializer();
  return undefined;
}

/** Read a decorator's first argument as either a string or a flattened object. */
export function readDecoratorArg(
  node: Node | undefined,
): { kind: "string"; value: string } | { kind: "object"; value: Record<string, string | number | boolean | undefined> } | { kind: "unknown" } {
  if (!node) return { kind: "unknown" };
  const lit = literalValue(node);
  if (typeof lit === "string") return { kind: "string", value: lit };
  if (Node.isObjectLiteralExpression(node)) return { kind: "object", value: objectToRecord(node) };
  return { kind: "unknown" };
}
