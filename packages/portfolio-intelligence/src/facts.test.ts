import { describe, expect, it } from "vitest";
import { derivePortfolioFacts } from "./facts.js";
import {
  makeDecision,
  makeFlatItem,
  makeInputs,
  makeItem,
  makeLongItem,
  makeShortItem,
} from "./test-fixtures.js";

/**
 * Shared facts — the single classification + aggregation point. Every position is partitioned
 * into exactly one lifecycle state; exposure/capital/risk aggregates fail closed; output is
 * order-independent (sorted) and deterministic.
 */

describe("derivePortfolioFacts — classification", () => {
  it("OPEN for an actionable, fresh, can-trade directional item", () => {
    const f = derivePortfolioFacts(makeInputs({ items: [makeLongItem()] }));
    expect(f.positions[0]?.state).toBe("OPEN");
    expect(f.openCount).toBe(1);
    expect(f.positions[0]?.contributesExposure).toBe(true);
  });

  it("FLAT for a no-edge item (excluded from exposure)", () => {
    const f = derivePortfolioFacts(makeInputs({ items: [makeFlatItem()] }));
    expect(f.positions[0]?.state).toBe("FLAT");
    expect(f.flatCount).toBe(1);
    expect(f.openCount).toBe(0);
    expect(f.grossExposure).toBe(0);
  });

  it("BLOCKED for a directional item when the kill switch is engaged", () => {
    const f = derivePortfolioFacts(makeInputs({ items: [makeLongItem()], killEngaged: true }));
    expect(f.positions[0]?.state).toBe("BLOCKED");
    expect(f.blockedCount).toBe(1);
    expect(f.grossExposure).toBe(0);
  });

  it("BLOCKED for a control-blocked directional item", () => {
    const f = derivePortfolioFacts(makeInputs({ items: [makeLongItem({ controlStatus: "BLOCKED" })] }));
    expect(f.positions[0]?.state).toBe("BLOCKED");
  });

  it("WAITING for an actionable-but-stale directional item (degrades from OPEN)", () => {
    const f = derivePortfolioFacts(makeInputs({ items: [makeLongItem({ signalAgeSeconds: 99_999 })] }));
    expect(f.positions[0]?.state).toBe("WAITING");
    expect(f.waitingCount).toBe(1);
    expect(f.staleCount).toBe(1);
    expect(f.openCount).toBe(0);
  });

  it("WAITING for a not-yet-actionable directional item", () => {
    const f = derivePortfolioFacts(makeInputs({ items: [makeLongItem({ overallStatus: "WAITING" })] }));
    expect(f.positions[0]?.state).toBe("WAITING");
  });

  it("partitions every item into exactly one state (counts sum to total)", () => {
    const f = derivePortfolioFacts(
      makeInputs({ items: [makeLongItem(), makeShortItem(), makeFlatItem(), makeLongItem({ signalId: "x", controlStatus: "BLOCKED" })] }),
    );
    expect(f.openCount + f.waitingCount + f.blockedCount + f.flatCount).toBe(f.totalCount);
    expect(f.totalCount).toBe(4);
  });
});

describe("derivePortfolioFacts — aggregates", () => {
  it("computes long/short/gross/net exposure from OPEN positions only", () => {
    const f = derivePortfolioFacts(makeInputs());
    expect(f.longExposure).toBe(10_000);
    expect(f.shortExposure).toBe(10_000);
    expect(f.grossExposure).toBe(20_000);
    expect(f.netExposure).toBe(0);
  });

  it("computes capital used/available/pct against assumed equity", () => {
    const f = derivePortfolioFacts(makeInputs());
    expect(f.assumedEquity).toBe(100_000);
    expect(f.capitalUsed).toBe(20_000);
    expect(f.capitalAvailable).toBe(80_000);
    expect(f.capitalPct).toBe(20);
  });

  it("computes risk used vs the documented budget (Σ maxLoss of OPEN)", () => {
    const f = derivePortfolioFacts(makeInputs());
    // each fixture: size 0.5 × |100 − 97| = 1.5 → Σ = 3
    expect(f.riskUsedAbs).toBe(3);
    expect(f.riskBudgetAbs).toBe(10_000);
    expect(f.riskRemainingAbs).toBe(9_997);
  });

  it("excludes non-OPEN notional from exposure (blocked exposes nothing)", () => {
    const f = derivePortfolioFacts(
      makeInputs({ items: [makeLongItem(), makeShortItem({ controlStatus: "BLOCKED" })] }),
    );
    expect(f.longExposure).toBe(10_000);
    expect(f.shortExposure).toBe(0);
    expect(f.grossExposure).toBe(10_000);
  });

  it("falls back to the config default equity when no decision carries one", () => {
    const item = makeItem(makeDecision({ assumedEquity: 0 }));
    const f = derivePortfolioFacts(makeInputs({ items: [item] }));
    expect(f.assumedEquity).toBe(100_000); // DEFAULT_PORTFOLIO_CONFIG.defaultEquity
  });
});

describe("derivePortfolioFacts — determinism + ordering", () => {
  it("is order-independent — shuffled items produce identical positions", () => {
    const a = derivePortfolioFacts(makeInputs({ items: [makeLongItem(), makeShortItem()] }));
    const b = derivePortfolioFacts(makeInputs({ items: [makeShortItem(), makeLongItem()] }));
    expect(JSON.stringify(a.positions)).toBe(JSON.stringify(b.positions));
  });

  it("sorts positions by symbol then signalId", () => {
    const f = derivePortfolioFacts(makeInputs({ items: [makeShortItem(), makeLongItem()] }));
    expect(f.positions.map((p) => p.symbol)).toEqual(["BTC-PERP", "ETH-PERP"]);
  });

  it("handles the empty portfolio fail-closed (no NaN)", () => {
    const f = derivePortfolioFacts(makeInputs({ items: [] }));
    expect(f.totalCount).toBe(0);
    expect(f.grossExposure).toBe(0);
    expect(f.capitalPct).toBe(0);
    expect(f.riskUsedPct).toBe(0);
    expect(Number.isNaN(f.capitalAvailable)).toBe(false);
  });
});
