import { describe, expect, it } from "vitest";
import { buildPortfolioStatistics } from "./statistics.js";
import { makeFlatItem, makeInputs, makeLongItem, makeShortItem } from "./test-fixtures.js";

describe("buildPortfolioStatistics", () => {
  it("computes averages / median / extremes over directional candidates", () => {
    const s = buildPortfolioStatistics(
      makeInputs({ items: [makeLongItem({ confidence: 0.8 }), makeShortItem({ confidence: 0.6 })] }),
    );
    expect(s.sampleSize).toBe(2);
    expect(s.averageConfidence).toBe(0.7);
    expect(s.medianConfidence).toBe(0.7);
    expect(s.highestConfidence).toBe(0.8);
    expect(s.lowestConfidence).toBe(0.6);
    expect(s.averageRiskReward).toBe(3); // both fixtures R:R 3
  });

  it("excludes FLAT candidates from the sample", () => {
    const s = buildPortfolioStatistics(makeInputs({ items: [makeLongItem(), makeFlatItem()] }));
    expect(s.sampleSize).toBe(1);
  });

  it("best / worst opportunity by readiness", () => {
    const s = buildPortfolioStatistics(
      makeInputs({ items: [makeLongItem({ confidence: 0.9 }), makeShortItem({ confidence: 0.55, riskRewardRatio: { value: 1.2, provenance: "derived", basis: "x" } })] }),
    );
    expect(s.bestOpportunity.symbol).toBe("BTC-PERP");
    expect(s.worstOpportunity.symbol).toBe("ETH-PERP");
  });

  it("distribution covers actions, readiness bands, regimes and confidence buckets", () => {
    const s = buildPortfolioStatistics(makeInputs());
    expect(Object.values(s.distribution.byAction).reduce((a, b) => a + b, 0)).toBe(2);
    expect(Object.values(s.distribution.byReadinessBand).reduce((a, b) => a + b, 0)).toBe(2);
    expect(s.distribution.confidenceBuckets.reduce((a, b) => a + b.count, 0)).toBe(2);
    expect(s.distribution.byRegime.reduce((a, b) => a + b.count, 0)).toBe(2);
  });

  it("fails closed to null over an empty / all-flat sample (no NaN)", () => {
    const s = buildPortfolioStatistics(makeInputs({ items: [makeFlatItem()] }));
    expect(s.sampleSize).toBe(0);
    expect(s.averageConfidence).toBeNull();
    expect(s.medianConfidence).toBeNull();
    expect(s.bestOpportunity.symbol).toBeNull();
  });

  it("is deterministic + order-independent", () => {
    const a = JSON.stringify(buildPortfolioStatistics(makeInputs({ items: [makeLongItem(), makeShortItem()] })));
    const b = JSON.stringify(buildPortfolioStatistics(makeInputs({ items: [makeShortItem(), makeLongItem()] })));
    expect(a).toBe(b);
  });
});
