import type { Handler } from "aws-lambda";
import { createHttpHandler, type FrameworkApp } from "./http.js";

/**
 * The slice of a NestJS `INestApplication` we actually touch. Kept structural —
 * no `@nestjs` import — so the runtime package stays framework-agnostic, exactly
 * like `http.ts` avoids a hard express dependency. The user's app supplies the
 * real instance at runtime.
 */
export interface NestAppLike {
  /** Idempotent in Nest: safe to call even if `bootstrap()` already listened. */
  init(): Promise<unknown>;
  /** Yields the underlying Express app (requires `@nestjs/platform-express`). */
  getHttpAdapter(): { getInstance(): FrameworkApp };
}

/**
 * The user's exported bootstrap: creates + configures a Nest app and RETURNS it
 * (`export default http(bootstrap)`). Unlike Express — a ready synchronous app —
 * a Nest app only exists after an async `NestFactory.create`, so laranja wraps the
 * factory rather than an instance.
 */
export type NestBootstrap = () => Promise<NestAppLike>;

/**
 * The Nest counterpart to `createHttpHandler`: wraps the user's bootstrap factory
 * in an API Gateway proxy handler (the single Lambda serving ALL routes).
 *
 * We run the user's `bootstrap()` verbatim — so every pipe/guard/middleware they
 * configured is preserved — then `init()` it (idempotent even if their bootstrap
 * also called `listen`), extract the underlying Express instance, and hand it to
 * the shared serverless-express adapter. The app + adapter are built once and
 * cached across warm invocations.
 */
export function createNestHttpHandler(bootstrap: NestBootstrap): Handler {
  let cached: Handler | undefined;
  return (async (event, context, callback) => {
    if (!cached) {
      const app = await bootstrap();
      await app.init();
      cached = createHttpHandler(app.getHttpAdapter().getInstance());
    }
    return cached(event, context, callback);
  }) as Handler;
}
