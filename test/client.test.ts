import { describe, test, expect, vi, afterEach } from "vitest";
import { postDestroy, type DestroyRequest } from "@alzulejos/laranja-core";

afterEach(() => vi.unstubAllGlobals());

const req: DestroyRequest = {
  stackName: "app-dev",
  artifact: "cloudformation",
  provider: "AWS",
  region: "us-east-1",
};

describe("postDestroy response parsing", () => {
  test("accepts a bare (unquoted) id string body — the destroy endpoint's shape", async () => {
    // A leading-digit id is exactly what tripped res.json() (\"position 1\").
    vi.stubGlobal("fetch", vi.fn(async () => new Response("7f3a-abc-123", { status: 200 })));
    expect(await postDestroy(req, "key", "http://test")).toBe("7f3a-abc-123");
  });

  test("accepts a JSON { deploymentId } body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ deploymentId: "abc" }), { status: 200 })),
    );
    expect(await postDestroy(req, "key", "http://test")).toBe("abc");
  });
});
