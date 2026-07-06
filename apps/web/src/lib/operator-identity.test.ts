/**
 * B2 — operator identity registry. Contract: a presented token resolves to its
 * configured operator id; an unknown token resolves to null; the legacy single
 * OPS_CONTROL_TOKEN yields exactly one identity; nothing configured -> not
 * usable (fail-closed).
 */

import { afterEach, describe, expect, it } from "vitest";
import { operatorsConfigured, resolveOperator } from "./operator-identity";

afterEach(() => {
  delete process.env.OPERATORS;
  delete process.env.OPS_CONTROL_TOKEN;
});

describe("operator-identity", () => {
  it("resolves distinct operators from JSON registry", () => {
    process.env.OPERATORS = JSON.stringify([
      { id: "alice", token: "tok-alice" },
      { id: "bob", token: "tok-bob" },
    ]);
    expect(operatorsConfigured()).toBe(true);
    expect(resolveOperator("tok-alice")).toEqual({ id: "alice" });
    expect(resolveOperator("tok-bob")).toEqual({ id: "bob" });
    expect(resolveOperator("tok-unknown")).toBeNull();
    expect(resolveOperator("")).toBeNull();
  });

  it("resolves operators from the compact id:token form", () => {
    process.env.OPERATORS = "alice:tok-alice,bob:tok-bob";
    expect(resolveOperator("tok-alice")).toEqual({ id: "alice" });
    expect(resolveOperator("tok-bob")).toEqual({ id: "bob" });
    expect(resolveOperator("nope")).toBeNull();
  });

  it("treats a legacy OPS_CONTROL_TOKEN as the single 'operator' identity", () => {
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    expect(operatorsConfigured()).toBe(true);
    expect(resolveOperator("legacy-shared")).toEqual({ id: "operator" });
    expect(resolveOperator("other")).toBeNull();
  });

  it("prefers OPERATORS over the legacy token when both are set", () => {
    process.env.OPERATORS = JSON.stringify([{ id: "alice", token: "tok-alice" }]);
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    expect(resolveOperator("tok-alice")).toEqual({ id: "alice" });
    expect(resolveOperator("legacy-shared")).toBeNull();
  });

  it("is not configured (fail-closed) when nothing is set", () => {
    expect(operatorsConfigured()).toBe(false);
    expect(resolveOperator("anything")).toBeNull();
  });

  it("ignores malformed OPERATORS JSON (fail-closed, no throw)", () => {
    process.env.OPERATORS = "[ not valid json";
    expect(operatorsConfigured()).toBe(false);
    expect(resolveOperator("anything")).toBeNull();
  });
});
