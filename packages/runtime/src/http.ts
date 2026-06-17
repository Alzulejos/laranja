import { configure } from "@codegenie/serverless-express";
import type { Handler } from "aws-lambda";

/**
 * The user's framework app (Express in v1). Typed via the adapter's own param so
 * we don't take a hard dependency on express's types here.
 */
export type FrameworkApp = Parameters<typeof configure>[0]["app"];

/**
 * Wraps the user's exported app in an API Gateway proxy handler. This is the
 * single Lambda that serves ALL HTTP routes (the proxy model). The adapter caches
 * its server across warm invocations internally.
 */
export function createHttpHandler(app: FrameworkApp): Handler {
  return configure({ app }) as Handler;
}
