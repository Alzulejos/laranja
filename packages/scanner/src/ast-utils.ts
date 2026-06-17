import { Node, SyntaxKind } from "ts-morph";
import type { ObjectLiteralExpression } from "ts-morph";
import { rate, every, type RateUnit } from "@laranja/core";

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
 * literal arguments. Returns the AWS schedule string, or undefined if the call
 * isn't a recognized helper or its args aren't literals.
 */
export function foldScheduleCall(node: Node | undefined): string | undefined {
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
 * Resolve a node used as a schedule into an AWS expression string. Accepts a raw
 * string literal or a `rate(...)`/`every(...)` helper call. Returns undefined for
 * anything non-static (e.g. a variable), so callers can raise a clear error.
 */
export function resolveScheduleNode(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  const lit = literalValue(node);
  if (typeof lit === "string") return lit;
  return foldScheduleCall(node);
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
