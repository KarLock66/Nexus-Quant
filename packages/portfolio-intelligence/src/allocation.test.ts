import { describe, expect, it } from "vitest";
import { buildCapitalAllocation } from "./allocation.js";
import { makeFlatItem, makeInputs, makeLongItem, makeShortItem, na } from "./test-fixtures.js";

const big = (notional: number) => ({ positionNotional: { value: notional, provenance: "derived" as const, basis: "x" } });

describe("buildCapitalAllocation", () => {
  it("discloses provenance on every top-line measure", () => {
    const a = buildCapitalAllocation(makeInputs());
    expect(a.capitalPct.provenance).toBe("derived");
    expect(a.riskPct.provenance).toBe("derived");
    expect(a.exposurePct.provenance).toBe("derived");
    expect(a.capitalPct.value).toBe(20); // gross 20k / equity 100k
    expect(a.exposurePct.value).toBe(0); // net 0
  });

  it("identifies the largest position / risk / opportunity", () => {
    const a = buildCapitalAllocation(
      makeInputs({ items: [makeLongItem(big(30_000)), makeShortItem(big(10_000))] }),
    );
    expect(a.largestPosition.symbol).toBe("BTC-PERP");
    expect(a.largestPosition.value).toBe(30_000);
    expect(a.largestOpportunity.symbol).not.toBeNull();
    expect(a.largestOpportunity.provenance).toBe("derived");
  });

  it("perSymbol shares are sorted by capital desc", () => {
    const a = buildCapitalAllocation(
      makeInputs({ items: [makeShortItem(big(10_000)), makeLongItem(big(30_000))] }),
    );
    expect(a.perSymbol[0]?.symbol).toBe("BTC-PERP");
  });

  it("concentration is 100 for a single-name book, lower when diversified", () => {
    const one = buildCapitalAllocation(makeInputs({ items: [makeLongItem()] }));
    const two = buildCapitalAllocation(makeInputs());
    expect(one.concentration.value).toBe(100);
    expect(two.concentration.value).toBe(50); // two equal names
  });

  it("fails closed to UNAVAILABLE refs when there is no open exposure", () => {
    const a = buildCapitalAllocation(makeInputs({ items: [makeFlatItem()] }));
    expect(a.largestPosition.symbol).toBeNull();
    expect(a.largestPosition.value).toBeNull();
    expect(a.largestPosition.provenance).toBe("unavailable");
    expect(a.concentration.provenance).toBe("unavailable");
    expect(a.capitalPct.value).toBe(0);
  });

  it("never reports a 0-from-absent superlative — an OPEN position with no notional source stays UNAVAILABLE", () => {
    const a = buildCapitalAllocation(makeInputs({ items: [makeLongItem({ positionNotional: na() })] }));
    expect(a.largestPosition.symbol).toBeNull();
    expect(a.largestPosition.value).toBeNull();
    expect(a.largestPosition.provenance).toBe("unavailable");
    // and the top-line measures downgrade to estimated (notional source partial)
    expect(a.capitalPct.provenance).toBe("estimated");
    expect(a.capitalPct.value).toBe(0);
  });

  it("is deterministic + order-independent", () => {
    const a = JSON.stringify(buildCapitalAllocation(makeInputs({ items: [makeLongItem(), makeShortItem()] })));
    const b = JSON.stringify(buildCapitalAllocation(makeInputs({ items: [makeShortItem(), makeLongItem()] })));
    expect(a).toBe(b);
  });
});
