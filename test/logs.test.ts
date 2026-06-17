import { describe, it, expect } from "vitest";
import { lambdaKind, type DeployedLambda } from "../packages/cli/src/aws.js";
import { shortLabel, matchByName, parseSince } from "../packages/cli/src/commands/logs.js";

describe("lambdaKind", () => {
  it("maps CDK logical-id prefixes to kinds", () => {
    expect(lambdaKind("HttpFn")).toBe("http");
    expect(lambdaKind("CronnightlyReportFn")).toBe("cron");
    expect(lambdaKind("ConsumerEmailQueueFn")).toBe("queue");
    expect(lambdaKind("SomethingElse")).toBe("lambda");
    expect(lambdaKind("")).toBe("lambda");
  });
});

describe("shortLabel", () => {
  it("strips the <app>- prefix and -<stage> suffix", () => {
    expect(shortLabel("myapp-app-dev", "myapp", "dev")).toBe("app");
    expect(shortLabel("myapp-refreshCache-dev", "myapp", "dev")).toBe("refreshCache");
    expect(shortLabel("myapp-app-prod", "myapp", "prod")).toBe("app");
  });

  it("leaves names that don't fit the pattern untouched", () => {
    expect(shortLabel("unrelated", "myapp", "dev")).toBe("unrelated");
  });
});

describe("parseSince", () => {
  it("parses each unit into milliseconds", () => {
    expect(parseSince("30s")).toBe(30_000);
    expect(parseSince("15m")).toBe(900_000);
    expect(parseSince("1h")).toBe(3_600_000);
    expect(parseSince("2d")).toBe(172_800_000);
  });

  it("rejects malformed durations", () => {
    expect(() => parseSince("abc")).toThrow();
    expect(() => parseSince("10x")).toThrow();
    expect(() => parseSince("")).toThrow();
    expect(() => parseSince("h")).toThrow();
  });
});

describe("matchByName", () => {
  const fns: DeployedLambda[] = [
    { kind: "http", logicalId: "HttpFn", functionName: "myapp-app-dev", logGroupName: "/aws/lambda/myapp-app-dev" },
    { kind: "cron", logicalId: "CronrefreshFn", functionName: "myapp-refreshCache-dev", logGroupName: "/aws/lambda/myapp-refreshCache-dev" },
    { kind: "queue", logicalId: "ConsumerEmailFn", functionName: "myapp-emailQueue-dev", logGroupName: "/aws/lambda/myapp-emailQueue-dev" },
  ];
  const label = (f: DeployedLambda) => shortLabel(f.functionName, "myapp", "dev");

  it("matches an exact short label", () => {
    expect(matchByName(fns, "app", label).map((f) => f.functionName)).toEqual(["myapp-app-dev"]);
  });

  it("matches an exact full function name", () => {
    expect(matchByName(fns, "myapp-refreshCache-dev", label).map((f) => f.kind)).toEqual(["cron"]);
  });

  it("matches a substring of the function name", () => {
    expect(matchByName(fns, "email", label).map((f) => f.kind)).toEqual(["queue"]);
  });

  it("can match multiple functions by substring", () => {
    expect(matchByName(fns, "myapp", label)).toHaveLength(3);
  });

  it("returns nothing when there is no match", () => {
    expect(matchByName(fns, "nope", label)).toEqual([]);
  });
});
