import { describe, expect, it } from "vitest";
import { buildPortfolioState } from "./portfolio.js";
import { buildPortfolioSummary } from "./summary.js";
import { buildRiskHeat } from "./heat.js";
import { makeFlatItem, makeInputs, makeLongItem, makeShortItem } from "./test-fixtures.js";

describe("buildPortfolioState — orchestration", () => {
  it("assembles all eight sections", () => {
    const st = buildPortfolioState(makeInputs());
    expect(st.summary).toBeDefined();
    expect(st.exposure).toBeDefined();
    expect(st.allocation).toBeDefined();
    expect(st.heat).toBeDefined();
    expect(st.health).toBeDefined();
    expect(st.warnings).toBeDefined();
    expect(st.statistics).toBeDefined();
    expect(st.positions.length).toBe(2);
  });

  it("sections agree by construction (single shared facts)", () => {
    const st = buildPortfolioState(makeInputs());
    expect(st.summary.status).toBe(st.health.status);
    expect(st.summary.currentExposure).toBe(st.exposure.grossExposure);
    expect(st.heat.heatBand).toBe(st.health.heatBand);
    // re-deriving a section in isolation matches the orchestrated one
    expect(JSON.stringify(st.summary)).toBe(JSON.stringify(buildPortfolioSummary(makeInputs())));
    expect(JSON.stringify(st.heat)).toBe(JSON.stringify(buildRiskHeat(makeInputs())));
  });

  it("is REPLAY-safe — identical inputs serialize byte-identically", () => {
    const a = JSON.stringify(buildPortfolioState(makeInputs()));
    const b = JSON.stringify(buildPortfolioState(makeInputs()));
    expect(a).toBe(b);
  });

  it("is ORDER-independent — shuffled items produce identical state", () => {
    const a = JSON.stringify(buildPortfolioState(makeInputs({ items: [makeLongItem(), makeShortItem(), makeFlatItem()] })));
    const b = JSON.stringify(buildPortfolioState(makeInputs({ items: [makeFlatItem(), makeShortItem(), makeLongItem()] })));
    expect(a).toBe(b);
  });

  it("the clock is injected — `now` does not leak into the serialized state", () => {
    const a = JSON.stringify(buildPortfolioState(makeInputs({ now: 1 })));
    const b = JSON.stringify(buildPortfolioState(makeInputs({ now: 9_999_999 })));
    expect(a).toBe(b);
  });

  it("fails closed for an EMPTY portfolio (no NaN, HEALTHY, zeros/nulls)", () => {
    const st = buildPortfolioState(makeInputs({ items: [] }));
    expect(st.positions).toEqual([]);
    expect(st.summary.currentExposure).toBe(0);
    expect(st.statistics.averageConfidence).toBeNull();
    expect(st.heat.heatScore).toBe(0);
    expect(JSON.stringify(st).includes("NaN")).toBe(false);
  });

  it("propagates nulls from FLAT-only inputs without fabricating values", () => {
    const st = buildPortfolioState(makeInputs({ items: [makeFlatItem()] }));
    expect(st.summary.flatTrades).toBe(1);
    expect(st.summary.openTrades).toBe(0);
    expect(st.allocation.largestPosition.value).toBeNull();
    expect(st.statistics.bestOpportunity.value).toBeNull();
    expect(st.warnings.warnings.some((w) => w.id === "no-actionable")).toBe(true);
  });
});
