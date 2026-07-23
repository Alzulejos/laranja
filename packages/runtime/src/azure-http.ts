import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { app as functionsApp, type HttpRequest, type InvocationContext, type HttpResponseInit } from "@azure/functions";
import { AZURE_HTTP_FUNCTION_NAME } from "@alzulejos/laranja-core";
import type { FrameworkApp } from "./http.js";

/**
 * Serve the user's app from an Azure Function App.
 *
 * Registration is a side effect (the Functions host discovers functions by
 * loading the package and reading its registry), so callers must invoke this at
 * module top level — the generated shim does.
 *
 * Unlike Lambda, where an API Gateway event is adapted into a Node req/res pair,
 * the v4 model hands us a WHATWG-style `HttpRequest` and expects an
 * `HttpResponseInit` back. An Express app speaks neither.
 *
 * `route: "{*path}"` is what preserves laranja's proxy model: ONE registered
 * function serves every route, and the framework routes internally.
 */
export function registerAzureHttp(expressApp: FrameworkApp): void {
  functionsApp.http(AZURE_HTTP_FUNCTION_NAME, {
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    // Anonymous: laranja's model is a public HTTP endpoint. Authorization is the
    // user's app's concern, as it is behind a Lambda Function URL.
    authLevel: "anonymous",
    route: "{*path}",
    handler: (request, context) => proxyToApp(expressApp, request, context),
  });
}

/**
 * The app's listener, created once per PROCESS and reused across invocations.
 *
 * Express is a `(req, res)` listener over Node's IncomingMessage/ServerResponse.
 * Rather than hand-roll fake request objects — which break on anything reading
 * `socket`, `rawHeaders` or streaming bodies — we run the real app on a loopback
 * port and forward to it, so it sees exactly what it would locally.
 *
 * The Functions host reuses the process across invocations, so this is paid once
 * at cold start, not per request.
 */
let listening: Promise<number> | undefined;
let server: Server | undefined;

function appPort(expressApp: FrameworkApp): Promise<number> {
  listening ??= (async () => {
    server = createServer(expressApp as unknown as Parameters<typeof createServer>[1]);
    // Port 0 = let the OS pick a free one; 127.0.0.1 keeps it off any interface.
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("laranja: could not determine the local app port");
    }
    return address.port;
  })();
  return listening;
}

async function proxyToApp(
  expressApp: FrameworkApp,
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const port = await appPort(expressApp);
  const url = new URL(request.url);

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // The loopback hop must not inherit the public Host header, or apps that build
  // absolute URLs from it would emit 127.0.0.1 links.
  delete headers.host;

  // GET/HEAD must not carry a body; anything else forwards the raw bytes.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      // Let the user's app own redirects — following them here would swallow a
      // 302 the caller is meant to see.
      redirect: "manual",
    });

    const outHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });

    return {
      status: res.status,
      headers: outHeaders,
      body: Buffer.from(await res.arrayBuffer()),
    };
  } catch (err) {
    context.error("laranja: proxying to the app failed", err);
    throw err;
  }
}
