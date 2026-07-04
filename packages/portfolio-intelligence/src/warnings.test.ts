import { describe, expect, it } from "vitest";
import { buildPortfolioWarnings } from "./warnings.js";
import { makeFlatItem, makeInputs, makeLongItem } from "./test-fixtures.js";

const notion = (n: number) => ({ positionNotional: { value: n, provenance: "derived" as const, basis: "x" } });
const ids = (inp: Parameters<typeof buildPortfolioWarnings>[0]) =>
  buildPortfolioWarnings(inp).warnings.map((w) => w.id);

describe("buildPortfolioWarnings", () => {
  it("no warnings for a small, balanced, all-green book", () => {
    const w = buildPortfolioWarnings(makeInputs());
    expect(w.warnings).toEqual([]);
    expect(w.critical + w.high + w.medium + w.low).toBe(0);
  });

  it("kill switch → CRITICAL control warning", () => {
    expect(ids(makeInputs({ killEngaged: true }))).toContain("kill-engaged");
  });

  it("control BLOCKED → CRITICAL", () => {
    expect(ids(makeInputs({ controlPermission: "BLOCKED" }))).toContain("control-blocked");
  });

  it("runtime not HEALTHY → HIGH; runtime unknown → LOW", () => {
    expect(ids(makeInputs({ runtimeState: "DEGRADED" }))).toContain("runtime-unhealthy");
    expect(ids(makeInputs({ runtimeState: null }))).toContain("runtime-unknown");
  });

  it("over-concentration + directional skew on a single-name long book", () => {
    const got = ids(makeInputs({ items: [makeLongItem(notion(50_000))] }));
    expect(got).toContain("over-concentrated");
    expect(got).toContain("long-skew");
  });

  it("no-capital when the book is fully deployed", () => {
    const got = ids(makeInputs({ items: [makeLongItem(notion(100_000))] }));
    expect(got).toContain("no-capital");
  });

  it("no-actionable + (flat) when every candidate stands aside", () => {
    expect(ids(makeInputs({ items: [makeFlatItem()] }))).toContain("no-actionable");
  });

  it("stale-decisions when a directional signal is past the freshness bound", () => {
    expect(ids(makeInputs({ items: [makeLongItem({ signalAgeSeconds: 99_999 })] }))).toContain("stale-decisions");
  });

  it("low-dq when a signal is below the DQ floor", () => {
    const item = makeLongItem();
    expect(ids(makeInputs({ items: [{ ...item, dqScore: 10 }] }))).toContain("low-dq");
  });

  it("every warning carries severity, source, provenance and basis", () => {
    for (const w of buildPortfolioWarnings(makeInputs({ killEngaged: true })).warnings) {
      expect(w.severity).toBeTruthy();
      expect(w.source).toBeTruthy();
      expect(w.provenance).toBeTruthy();
      expect(w.basis.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic + order-independent", () => {
    const a = JSON.stringify(buildPortfolioWarnings(makeInputs({ killEngaged: true })));
    const b = JSON.stringify(buildPortfolioWarnings(makeInputs({ killEngaged: true })));
    expect(a).toBe(b);
  });
});
