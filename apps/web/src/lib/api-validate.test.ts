/**
 * Phase 11C Stage 1 — strict /api/v1 request-input validation.
 *
 * Contract: absent optional input -> documented default; PRESENT-but-malformed
 * input -> explicit error (never a silent fallback). Timestamps are canonical
 * ISO-8601 UTC with millisecond precision.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalTimestamp,
  optionalStringField,
  parseBoundedInt,
  parseCursorId,
  parseEnumParam,
  parseOptionalString,
  parseRequiredSymbol,
  parseResourceId,
  parseSymbolFilter,
  readJsonObject,
  requireStringField,
} from "./api-validate";

const jsonReq = (body: string): Request =>
  new Request("http://test.local/api/v1/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

describe("canonicalTimestamp", () => {
  it("is ISO-8601 UTC with millisecond precision and Z suffix", () => {
    expect(canonicalTimestamp(new Date(Date.UTC(2026, 6, 5, 1, 2, 3, 45)))).toBe(
      "2026-07-05T01:02:03.045Z",
    );
    expect(canonicalTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("parseBoundedInt", () => {
  it("defaults when absent, accepts in-range integers", () => {
    expect(parseBoundedInt(null, "limit", 1, 200, 50)).toEqual({ ok: true, value: 50 });
    expect(parseBoundedInt("200", "limit", 1, 200, 50)).toEqual({ ok: true, value: 200 });
  });

  it.each(["abc", "1.5", "1e3", "", " ", "0", "201", "-1"])(
    "rejects malformed/out-of-range %j",
    (raw) => {
      expect(parseBoundedInt(raw, "limit", 1, 200, 50).ok).toBe(false);
    },
  );
});

describe("parseEnumParam", () => {
  const windows = ["1h", "24h", "7d", "30d"] as const;
  it("defaults when absent, accepts known values", () => {
    expect(parseEnumParam(null, "window", windows, "24h")).toEqual({ ok: true, value: "24h" });
    expect(parseEnumParam("7d", "window", windows, "24h")).toEqual({ ok: true, value: "7d" });
  });
  it("rejects unknown values instead of coercing to the default", () => {
    expect(parseEnumParam("48h", "window", windows, "24h").ok).toBe(false);
    expect(parseEnumParam("", "window", windows, "24h").ok).toBe(false);
  });
});

describe("parseOptionalString", () => {
  it("absent -> undefined; present -> trimmed value", () => {
    expect(parseOptionalString(null, "q", 200)).toEqual({ ok: true, value: undefined });
    expect(parseOptionalString(" kill ", "q", 200)).toEqual({ ok: true, value: "kill" });
  });
  it("rejects empty and over-long values", () => {
    expect(parseOptionalString("", "q", 200).ok).toBe(false);
    expect(parseOptionalString("   ", "q", 200).ok).toBe(false);
    expect(parseOptionalString("x".repeat(201), "q", 200).ok).toBe(false);
  });
});

describe("symbol validation", () => {
  it("accepts real instrument grammars", () => {
    for (const s of ["BTC-PERP", "ETH-PERP", "BTC_USDC-PERPETUAL", "deribit:BTC-PERP", "BTC.D"]) {
      expect(parseRequiredSymbol(s, "symbol").ok).toBe(true);
    }
  });
  it("rejects absent, empty, and hostile symbols", () => {
    expect(parseRequiredSymbol(null, "symbol").ok).toBe(false);
    expect(parseRequiredSymbol("  ", "symbol").ok).toBe(false);
    expect(parseRequiredSymbol("-BTC", "symbol").ok).toBe(false);
    expect(parseRequiredSymbol("BTC PERP", "symbol").ok).toBe(false);
    expect(parseRequiredSymbol("B".repeat(33), "symbol").ok).toBe(false);
    expect(parseRequiredSymbol("BTC;DROP TABLE", "symbol").ok).toBe(false);
  });

  it("filter: absent -> undefined (no filter); list parses verbatim", () => {
    expect(parseSymbolFilter(null, "symbol")).toEqual({ ok: true, value: undefined });
    expect(parseSymbolFilter("BTC-PERP,ETH-PERP", "symbol")).toEqual({
      ok: true,
      value: ["BTC-PERP", "ETH-PERP"],
    });
  });
  it("filter: rejects empty tokens instead of silently dropping them", () => {
    expect(parseSymbolFilter("", "symbol").ok).toBe(false);
    expect(parseSymbolFilter(",,,", "symbol").ok).toBe(false);
    expect(parseSymbolFilter("BTC-PERP,", "symbol").ok).toBe(false);
    expect(parseSymbolFilter("BTC-PERP,%%%", "symbol").ok).toBe(false);
    expect(parseSymbolFilter(Array.from({ length: 21 }, (_, i) => `S${i}`).join(","), "symbol").ok).toBe(false);
  });
});

describe("resource/cursor ids", () => {
  it("accepts cuids and fixture-style ids", () => {
    expect(parseResourceId("ci-fs-btc-perp-h1", "id").ok).toBe(true);
    expect(parseResourceId("cmc3z9k2l0001abcd", "id").ok).toBe(true);
    expect(parseCursorId(null, "cursor")).toEqual({ ok: true, value: undefined });
    expect(parseCursorId("page-sig-24", "cursor")).toEqual({ ok: true, value: "page-sig-24" });
  });
  it("rejects empty, over-long, and out-of-charset ids", () => {
    expect(parseResourceId("", "id").ok).toBe(false);
    expect(parseResourceId("a b", "id").ok).toBe(false);
    expect(parseResourceId("a".repeat(129), "id").ok).toBe(false);
    expect(parseCursorId("", "cursor").ok).toBe(false);
    expect(parseCursorId("x;y", "cursor").ok).toBe(false);
  });
});

describe("readJsonObject", () => {
  it("accepts a JSON object body", async () => {
    expect(await readJsonObject(jsonReq('{"reason":"drill"}'))).toEqual({
      ok: true,
      value: { reason: "drill" },
    });
  });
  it.each([
    ["invalid JSON", "{nope"],
    ["array", "[1,2]"],
    ["string", '"reason"'],
    ["number", "42"],
    ["null", "null"],
  ])("rejects %s bodies", async (_name, body) => {
    expect((await readJsonObject(jsonReq(body))).ok).toBe(false);
  });
});

describe("body field validation", () => {
  it("requireStringField: non-empty bounded string passes verbatim (untrimmed)", () => {
    expect(requireStringField({ reason: " drill " }, "reason", 2000)).toEqual({
      ok: true,
      value: " drill ",
    });
    expect(requireStringField({}, "reason", 2000).ok).toBe(false);
    expect(requireStringField({ reason: "  " }, "reason", 2000).ok).toBe(false);
    expect(requireStringField({ reason: 7 }, "reason", 2000).ok).toBe(false);
    expect(requireStringField({ reason: "x".repeat(2001) }, "reason", 2000).ok).toBe(false);
  });

  it("optionalStringField: absent -> fallback; present-but-malformed -> error", () => {
    expect(optionalStringField({}, "actor", 200, "operator")).toEqual({
      ok: true,
      value: "operator",
    });
    expect(optionalStringField({ actor: "kar" }, "actor", 200, "operator")).toEqual({
      ok: true,
      value: "kar",
    });
    expect(optionalStringField({ actor: "" }, "actor", 200, "operator").ok).toBe(false);
    expect(optionalStringField({ actor: null }, "actor", 200, "operator").ok).toBe(false);
    expect(optionalStringField({ actor: 42 }, "actor", 200, "operator").ok).toBe(false);
  });
});
