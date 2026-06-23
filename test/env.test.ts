import { describe, test, expect } from "vitest";
import { resolveDeclaredEnv, envParamName } from "@alzulejos/laranja-core";

describe("resolveDeclaredEnv", () => {
  test("splits declared keys into resolved values and missing names", () => {
    const { resolved, missing } = resolveDeclaredEnv(["DATABASE_URL", "STRIPE_KEY", "EMPTY"], {
      DATABASE_URL: "postgres://x",
      EMPTY: "", // explicit empty string is a deliberate value, not "missing"
    });
    expect(resolved).toEqual({ DATABASE_URL: "postgres://x", EMPTY: "" });
    expect(missing).toEqual(["STRIPE_KEY"]);
  });

  test("no declared keys -> nothing resolved, nothing missing", () => {
    expect(resolveDeclaredEnv([], { ANYTHING: "1" })).toEqual({ resolved: {}, missing: [] });
  });
});

describe("envParamName", () => {
  test("produces an alphanumeric CloudFormation Parameter logical id", () => {
    expect(envParamName("DATABASE_URL")).toBe("EnvDATABASEURL");
    expect(envParamName("stripe.key-1")).toBe("Envstripekey1");
  });
});
