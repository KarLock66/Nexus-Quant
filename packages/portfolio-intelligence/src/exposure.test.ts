import { describe, expect, it } from "vitest";
import { buildPortfolioExposure } from "./exposure.js";
import { makeFlatItem, makeInputs, makeLongItem, makeShortItem } from "./test-fixtures.js";

const share = (groups: { key: string; sharePct: number }[]) =>
  groups.reduce((a, g) => a + g.sharePct, 0);

describe("buildPortfolioExposure", () => {
  it("groups OPEN exposure by symbol / side / regime, shares sum to ~100", () => {
    const e = buildPortfolioExposure(makeInputs());
    expect(e.bySymbol.map((g) => g.key).sort()).toEqual(["BTC-PERP", "ETH-PERP"]);
    expect(e.bySide.map((g) => g.key).sort()).toEqual(["LONG", "SHORT"]);
    expect(share(e.bySymbol)).toBeCloseTo(100, 5);
    expect(share(e.bySide)).toBeCloseTo(100, 5);
    expect(e.grossExposure).toBe(20_000);
    expect(e.netExposure).toBe(0);
  });

  it("sorts groups by notional desc then key asc (deterministic)", () => {
    const e = buildPortfolioExposure(
      makeInputs({ items: [makeShortItem({ positionNotional: { value: 30_000, provenance: "derived", basis: "x" } }), makeLongItem()] }),
    );
    expect(e.bySymbol[0]?.key).toBe("ETH-PERP"); // 30k short outranks 10k long
    expect(e.bySymbol[0]?.notional).toBe(30_000);
  });

  it("byState spans ALL candidates (waiting/blocked/flat visible)", () => {
    const e = buildPortfolioExposure(
      makeInputs({ items: [makeLongItem(), makeShortItem({ controlStatus: "BLOCKED" }), makeFlatItem()] }),
    );
    const states = e.buckets.byState.map((g) => g.key).sort();
    expect(states).toEqual(["BLOCKED", "FLAT", "OPEN"]);
    const total = e.buckets.byState.reduce((a, g) => a + g.count, 0);
    expect(total).toBe(3);
  });

  it("byState notional is LIVE exposure only — non-OPEN states hold $0 despite candidate notional", () => {
    const e = buildPortfolioExposure(
      makeInputs({ items: [makeLongItem(), makeShortItem({ controlStatus: "BLOCKED" })] }),
    );
    expect(e.buckets.byState.find((g) => g.key === "OPEN")?.notional).toBe(10_000);
    const blocked = e.buckets.byState.find((g) => g.key === "BLOCKED");
    expect(blocked?.count).toBe(1); // the blocked candidate is visible…
    expect(blocked?.notional).toBe(0); // …but contributes $0 live exposure
  });

  it("buckets OPEN exposure by confidence and risk band", () => {
    const e = buildPortfolioExposure(makeInputs());
    expect(e.buckets.byConfidence.every((g) => ["HIGH", "MEDIUM", "LOW"].includes(g.key))).toBe(true);
    expect(e.buckets.byRisk.every((g) => ["LOW", "MODERATE", "HIGH", "UNKNOWN"].includes(g.key))).toBe(true);
  });

  it("empty / no-open portfolio yields empty groupings (no NaN shares)", () => {
    const e = buildPortfolioExposure(makeInputs({ items: [makeFlatItem()] }));
    expect(e.bySymbol).toEqual([]);
    expect(e.grossExposure).toBe(0);
    expect(e.buckets.byState.find((g) => g.key === "FLAT")?.count).toBe(1);
  });

  it("is deterministic + order-independent", () => {
    const a = JSON.stringify(buildPortfolioExposure(makeInputs({ items: [makeLongItem(), makeShortItem()] })));
    const b = JSON.stringify(buildPortfolioExposure(makeInputs({ items: [makeShortItem(), makeLongItem()] })));
    expect(a).toBe(b);
  });
});
