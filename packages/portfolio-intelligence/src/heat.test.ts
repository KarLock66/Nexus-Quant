import { describe, expect, it } from "vitest";
import { buildRiskHeat, concentrationScore } from "./heat.js";
import { derivePortfolioFacts } from "./facts.js";
import { makeFlatItem, makeInputs, makeLongItem, makeShortItem } from "./test-fixtures.js";

const notion = (n: number) => ({ positionNotional: { value: n, provenance: "derived" as const, basis: "x" } });

describe("buildRiskHeat", () => {
  it("documented weights sum to 100", () => {
    const h = buildRiskHeat(makeInputs());
    expect(h.components.reduce((a, c) => a + c.weight, 0)).toBe(100);
    expect(h.heatScore).toBeGreaterThanOrEqual(0);
    expect(h.heatScore).toBeLessThanOrEqual(100);
    expect(h.heatScore + h.portfolioStability).toBeCloseTo(100, 5);
  });

  it("COOL with a small, balanced, well-funded book", () => {
    const h = buildRiskHeat(makeInputs());
    expect(h.heatBand).toBe("COOL");
  });

  it("hotter as capital + concentration + skew rise", () => {
    const cool = buildRiskHeat(makeInputs());
    const hot = buildRiskHeat(makeInputs({ items: [makeLongItem(notion(95_000))] })); // 95% capital, 100% concentration, 100% skew
    expect(hot.heatScore).toBeGreaterThan(cool.heatScore);
  });

  it("concentration = 100 single name, 50 for two equal names", () => {
    expect(concentrationScore(derivePortfolioFacts(makeInputs({ items: [makeLongItem()] })))).toBe(100);
    expect(concentrationScore(derivePortfolioFacts(makeInputs()))).toBe(50);
    expect(buildRiskHeat(makeInputs()).diversificationScore).toBe(50);
  });

  it("COOL with no open exposure (nothing deployed)", () => {
    const h = buildRiskHeat(makeInputs({ items: [makeFlatItem()] }));
    expect(h.heatBand).toBe("COOL");
    expect(h.heatScore).toBe(0);
    expect(h.concentrationScore).toBe(0);
  });

  it("is deterministic + order-independent", () => {
    const a = JSON.stringify(buildRiskHeat(makeInputs({ items: [makeLongItem(), makeShortItem()] })));
    const b = JSON.stringify(buildRiskHeat(makeInputs({ items: [makeShortItem(), makeLongItem()] })));
    expect(a).toBe(b);
  });
});
