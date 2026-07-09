/**
 * B3 — Edge-safe operator registry parsing. Contract: the env configuration
 * parses to { id, token } entries (JSON form, compact form, legacy
 * OPS_CONTROL_TOKEN fallback as the single "operator" identity); malformed
 * configuration parses to an empty registry (fail-closed); membership of an
 * already-authenticated subject is checked against the CURRENT registry.
 * This module must stay importable in the Edge runtime — no node:crypto.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isRegisteredOperatorId, parseOperatorRegistry } from "./operator-registry";

afterEach(() => {
  delete process.env.OPERATORS;
  delete process.env.OPS_CONTROL_TOKEN;
});

describe("parseOperatorRegistry", () => {
  it("parses the JSON registry form verbatim", () => {
    process.env.OPERATORS = JSON.stringify([
      { id: "alice", token: "tok-alice" },
      { id: "bob", token: "tok-bob" },
    ]);
    expect(parseOperatorRegistry()).toEqual([
      { id: "alice", token: "tok-alice" },
      { id: "bob", token: "tok-bob" },
    ]);
  });

  it("parses the compact id:token form (token keeps everything after the first colon)", () => {
    process.env.OPERATORS = "alice:tok-alice,bob:tok:with:colons";
    expect(parseOperatorRegistry()).toEqual([
      { id: "alice", token: "tok-alice" },
      { id: "bob", token: "tok:with:colons" },
    ]);
  });

  it("falls back to the legacy OPS_CONTROL_TOKEN as the single 'operator' identity", () => {
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    expect(parseOperatorRegistry()).toEqual([{ id: "operator", token: "legacy-shared" }]);
  });

  it("prefers OPERATORS over the legacy token when both are set", () => {
    process.env.OPERATORS = JSON.stringify([{ id: "alice", token: "tok-alice" }]);
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    expect(parseOperatorRegistry()).toEqual([{ id: "alice", token: "tok-alice" }]);
  });

  it("parses to an empty registry when nothing is set (fail-closed)", () => {
    expect(parseOperatorRegistry()).toEqual([]);
  });

  it("parses malformed OPERATORS JSON to an empty registry (fail-closed, no throw)", () => {
    process.env.OPERATORS = "[ not valid json";
    expect(parseOperatorRegistry()).toEqual([]);
  });

  it("skips entries with a blank id or token in either form", () => {
    process.env.OPERATORS = JSON.stringify([
      { id: "  ", token: "tok" },
      { id: "alice", token: "" },
      { id: "bob", token: "tok-bob" },
    ]);
    expect(parseOperatorRegistry()).toEqual([{ id: "bob", token: "tok-bob" }]);

    process.env.OPERATORS = "no-colon-pair,:leading-colon,carol:tok-carol, :x";
    expect(parseOperatorRegistry()).toEqual([{ id: "carol", token: "tok-carol" }]);
  });
});

describe("isRegisteredOperatorId", () => {
  it("accepts a currently-registered id and rejects unknown or empty ids", () => {
    process.env.OPERATORS = "alice:tok-alice,bob:tok-bob";
    expect(isRegisteredOperatorId("alice")).toBe(true);
    expect(isRegisteredOperatorId("bob")).toBe(true);
    expect(isRegisteredOperatorId("mallory")).toBe(false);
    expect(isRegisteredOperatorId("")).toBe(false);
  });

  it("accepts the legacy 'operator' identity while OPS_CONTROL_TOKEN is configured", () => {
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    expect(isRegisteredOperatorId("operator")).toBe(true);
  });

  it("rejects the legacy 'operator' identity once a named registry replaces it", () => {
    process.env.OPERATORS = "alice:tok-alice";
    process.env.OPS_CONTROL_TOKEN = "legacy-shared";
    expect(isRegisteredOperatorId("operator")).toBe(false);
    expect(isRegisteredOperatorId("alice")).toBe(true);
  });

  it("rejects everyone when nothing is configured (fail-closed)", () => {
    expect(isRegisteredOperatorId("operator")).toBe(false);
    expect(isRegisteredOperatorId("alice")).toBe(false);
  });
});

describe("edge-safety", () => {
  it("imports no Node-only module (must stay loadable in the Edge runtime)", () => {
    const src = readFileSync(new URL("./operator-registry.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["']node:/);
    expect(src).not.toMatch(/require\(\s*["']node:/);
  });
});
